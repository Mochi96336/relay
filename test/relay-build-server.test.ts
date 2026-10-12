import assert from 'node:assert/strict';
import test from 'node:test';

import { participantIdForCapability } from '../src/participant-capability.js';
import { RelayClient, startRelay } from './helpers/harness.js';

const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

async function authenticatedMic(server: Awaited<ReturnType<typeof startRelay>>, capability: string, build?: string) {
  const participantId = participantIdForCapability(capability);
  assert.ok(participantId);
  const client = await RelayClient.connect(server);
  client.send({
    type: 'participant-authenticate',
    participantId,
    capability,
    nickname: 'Singer',
    ...(build === undefined ? {} : { build }),
  });
  const authenticated = await client.waitForType('participant-authenticated');
  client.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
  await client.waitForType('registered');
  return { client, authenticated };
}

test('the served page, the authentication reply and /statusz agree on one build (#487)', async () => {
  const server = await startRelay(FAST);
  try {
    const html = await fetch(server.httpUrl('/')).then((response) => response.text());
    const served = html.match(/<meta name="relay-build" content="([0-9a-f]{12})" \/>/)?.[1];
    assert.ok(served, 'index.html carries the build');

    const current = await authenticatedMic(server, 'ab'.repeat(32), served);
    assert.equal(current.authenticated.build, served);
    const status = await fetch(server.httpUrl('/statusz')).then((response) => response.json()) as any;
    assert.deepEqual(status.build, { relay: served, micPage: served });
    current.client.close();
  } finally {
    await server.stop();
  }
});

test('a Mic page from before builds existed is visible as such in /statusz', async () => {
  const server = await startRelay(FAST);
  try {
    const old = await authenticatedMic(server, 'cd'.repeat(32));
    const relay = old.authenticated.build;
    assert.match(relay, /^[0-9a-f]{12}$/, 'an old page simply ignores the field');
    const status = await fetch(server.httpUrl('/statusz')).then((response) => response.json()) as any;
    assert.deepEqual(status.build, { relay, micPage: null });
    old.client.close();
  } finally {
    await server.stop();
  }
});
