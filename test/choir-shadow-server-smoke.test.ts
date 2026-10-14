import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay, RelayClient } from './helpers/harness.js';
import { encodePcmFrame } from '../src/pcm-frame.js';
import { participantIdForCapability } from '../src/participant-capability.js';

/**
 * Real production entrypoint smoke: opt-in Choir observes only.
 * No Mic admission, new client message, PCM routing or monitoring output
 * is enabled by this flag.
 */
test('flagged Choir control-plane shadow starts and shuts down ordinary Relay cleanly', async () => {
  const relay = await startRelay({ RELAY_CHOIR_SHADOW: '1' });
  try {
    const response = await fetch(relay.httpUrl('/'));
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.ok(page.length > 0);
  } finally {
    await relay.stop();
  }
});

test('shadow server rejects unapproved Choir registration while ordinary sockets still work', async () => {
  const relay = await startRelay({ RELAY_CHOIR_SHADOW: '1' });
  let unknown: RelayClient | null = null;
  let publisher: RelayClient | null = null;
  try {
    unknown = await RelayClient.connect(relay);
    // No public Choir registration protocol exists, even with the shadow
    // flag ON. Client-asserted seat and room epochs are not capabilities.
    unknown.send({
      type: 'choir-secondary-register', role: 'secondary',
      participantId: 'B', roomEpoch: 1, songEpoch: 1,
      transportId: 'forged-B', mediaEpoch: 2, sampleRate: 48_000,
    });
    unknown.sendBinary(encodePcmFrame(7, 0,
      Buffer.from(new Int16Array(960).fill(8_000).buffer)));
    // Same physical socket can still use an ordinary, pre-existing role:
    // the unapproved Choir JSON/PCM did not seize media authority.
    unknown.send({ type: 'register', role: 'monitor' });
    assert.equal((await unknown.waitForType('registered')).role, 'monitor');
    assert.equal(unknown.messages.some(message =>
      message.type === 'choir-secondary-registered'), false);

    publisher = await RelayClient.connect(relay);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    assert.equal((await publisher.waitForType('registered')).role, 'publisher');
    publisher.sendPcm(Buffer.from(new Int16Array(960).fill(5_000).buffer));
    assert.equal(publisher.errors.length, 0,
      'production N=1 publisher remains available with Choir shadow enabled');
  } finally {
    unknown?.close();
    publisher?.close();
    await relay.stop();
  }
});

test('Choir invite commands require browser capability and never grant audio without Robot authority', async () => {
  const relay = await startRelay({ RELAY_CHOIR_SHADOW: '1',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0' });
  let anonymous: RelayClient | null = null;
  let a: RelayClient | null = null;
  let b: RelayClient | null = null;
  try {
    anonymous = await RelayClient.connect(relay);
    anonymous.send({ type: 'choir-secondary-invite', secondaryId: 'participant-pretend' });
    assert.equal((await anonymous.waitForType('choir-consent-rejected')).reason,
      'unavailable', 'an unidentified WebSocket cannot invite B');

    const capA = 'a'.repeat(64);
    const capB = 'b'.repeat(64);
    const idA = participantIdForCapability(capA)!;
    const idB = participantIdForCapability(capB)!;
    a = await RelayClient.connect(relay);
    b = await RelayClient.connect(relay);
    a.send({ type: 'participant-authenticate', participantId: idA,
      capability: capA, nickname: 'A' });
    b.send({ type: 'participant-authenticate', participantId: idB,
      capability: capB, nickname: 'B' });
    assert.equal((await a.waitForType('participant-authenticated')).participantId, idA);
    assert.equal((await b.waitForType('participant-authenticated')).participantId, idB);
    a.send({ type: 'choir-secondary-invite', secondaryId: idB });
    assert.equal((await a.waitForType('choir-consent-rejected')).reason,
      'invalid-or-stale',
      'even an authenticated browser is not granted a Choir room without the live primary Mic and Robot');
    b.send({ type: 'choir-secondary-accept',
      inviteId: '00000000-0000-0000-0000-000000000000' });
    assert.equal((await b.waitForType('choir-consent-rejected')).reason,
      'invalid-or-stale');
    assert.equal(a.messages.some(m => m.type === 'choir-secondary-invite-acknowledged'), false);
    assert.equal(b.messages.some(m => m.type === 'choir-secondary-invitation'), false);
    assert.equal(a.messages.some(m => m.type === 'choir-secondary-registered'), false);
    assert.equal(b.messages.some(m => m.type === 'choir-secondary-registered'), false);
  } finally {
    anonymous?.close();
    a?.close();
    b?.close();
    await relay.stop();
  }
});
