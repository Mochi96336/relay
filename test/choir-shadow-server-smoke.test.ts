import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay, RelayClient, sleep } from './helpers/harness.js';
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

test('real authenticated A and B complete opt-in and withdrawal without obtaining Choir PCM permission', async () => {
  const relay = await startRelay({
    RELAY_CHOIR_SHADOW: '1', RELAY_TEST_LEGACY_PARTICIPANTS: '0',
    RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000',
  });
  const clients: RelayClient[] = [];
  const connect = async () => {
    const c = await RelayClient.connect(relay);
    clients.push(c);
    return c;
  };
  try {
    const [a, b, publisher, robotBacking, robotControl] = await Promise.all(
      Array.from({ length: 5 }, () => connect()),
    );
    const capA = 'c'.repeat(64);
    const capB = 'd'.repeat(64);
    const idA = participantIdForCapability(capA)!;
    const idB = participantIdForCapability(capB)!;
    const authenticate = async (client: RelayClient, id: string, cap: string) => {
      client.send({ type: 'participant-authenticate', participantId: id,
        capability: cap, nickname: id === idA ? 'A' : 'B' });
      await client.waitFor((m) =>
        m.type === 'participant-authenticated' && m.participantId === id);
    };
    await Promise.all([
      authenticate(a, idA, capA),
      authenticate(b, idB, capB),
      authenticate(publisher, idA, capA),
    ]);
    assert.equal((await a.waitForType('choir-consent-available')).mode,
      'invitation-only');

    publisher.send({ type: 'register', role: 'publisher',
      sampleRate: 48_000, captureGeneration: 1 });
    await publisher.waitFor((m) =>
      m.type === 'registered' && m.role === 'publisher');
    robotBacking.send({ type: 'register', role: 'backing', robot: true,
      sampleRate: 48_000, captureGeneration: 9 });
    await robotBacking.waitFor((m) =>
      m.type === 'registered' && m.role === 'backing');
    robotControl.send({ type: 'robot-source-hello' });

    a.send({ type: 'playback-hello',
      playbackTransportId: 'choir-invite-playback-a',
      playbackGeneration: 1 });
    await a.waitForType('playback-registered');
    a.send({ type: 'room-song-command', commandId: 'invite-load-1',
      expectedRevision: 0, action: 'load',
      videoId: 'dQw4w9WgXcQ', positionSeconds: 10 });
    await a.waitFor((m) =>
      m.type === 'room-song-command-apply' && m.commandId === 'invite-load-1');
    const telemetry = (state: number, position: number) => ({
      type: 'youtube-telemetry', videoId: 'dQw4w9WgXcQ',
      state, currentTime: position, duration: 200,
      playbackRate: 1, bufferedFraction: .8,
      playbackTransportId: 'choir-invite-playback-a',
      playbackGeneration: 1,
    });
    a.send(telemetry(5, 10));
    await a.waitFor((m) =>
      m.type === 'room-song-command-complete' && m.commandId === 'invite-load-1');
    a.send({ type: 'room-song-command', commandId: 'invite-play-1',
      expectedRevision: 1, action: 'play' });
    await a.waitFor((m) =>
      m.type === 'room-song-command-apply' && m.commandId === 'invite-play-1');
    a.send(telemetry(1, 10.1));
    await a.waitFor((m) =>
      m.type === 'room-song-command-complete' && m.commandId === 'invite-play-1');
    await sleep(350); // One regular server-owned shadow clock observation.

    a.send({ type: 'choir-secondary-invite', secondaryId: idB });
    const invitation = await b.waitForType('choir-secondary-invitation');
    assert.equal(invitation.primaryId, idA);
    assert.ok(Number.isSafeInteger(invitation.roomEpoch));
    assert.equal(invitation.videoId, 'dQw4w9WgXcQ');
    await a.waitForType('choir-secondary-invite-acknowledged');

    b.send({ type: 'choir-secondary-accept', inviteId: invitation.inviteId });
    assert.equal((await a.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'accepted')).secondaryId, idB);
    assert.equal((await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'accepted')).secondaryId, idB);
    assert.equal(b.messages.some(m => m.type === 'choir-secondary-registered'), false,
      'B consent must not mint a microphone publisher or Media Epoch');

    b.send({ type: 'choir-secondary-withdraw' });
    assert.equal((await b.waitFor((m) =>
      m.type === 'choir-secondary-consent-status'
      && m.status === 'withdrawn')).secondaryId, idB);
    assert.equal((await a.waitFor((m) =>
      m.type === 'choir-secondary-consent-status'
      && m.status === 'withdrawn')).secondaryId, idB);
  } finally {
    for (const c of clients) c.close();
    await relay.stop();
  }
});
