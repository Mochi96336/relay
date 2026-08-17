import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
} from './helpers/harness.js';

const RATE = 48_000;
const INFRA_KEY = 'ab'.repeat(32);

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for new message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

async function authenticateInfrastructure(client: RelayClient) {
  client.send({ type: 'infrastructure-authenticate', key: INFRA_KEY });
  await client.waitForType('infrastructure-authenticated');
}

test('a backing WebSocket cannot morph into a monitor and split readiness from PCM ingest', async () => {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_HEARTBEAT_MS: '60000',
    RELAY_INFRA_KEY: INFRA_KEY,
    RELAY_TEST_LEGACY_INFRASTRUCTURE: '0',
  });
  try {
    const backing = await RelayClient.connect(server);
    await authenticateInfrastructure(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitFor((message) => message.type === 'registered' && message.role === 'backing');

    const from = backing.messages.length;
    backing.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(
      backing,
      from,
      (message) => message.type === 'role-conflict',
    );
    assert.equal(conflict.currentRole, 'backing');
    assert.equal(conflict.requestedRole, 'monitor');

    await sendPcmInChunks(backing, tone(0.35, 0.7));
    const status = await (await fetch(server.httpUrl('/statusz'))).json() as Record<string, any>;
    assert.equal(status.source.backingConnected, true);
    assert.equal(
      status.source.backingStreaming,
      true,
      'rejected role reuse must leave backing ingest and readiness on the same transport truth',
    );
    backing.close();
  } finally {
    await server.stop();
  }
});

test('a publisher WebSocket cannot become a monitor while the Mic pointer still references it', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const publisher = await RelayClient.connect(
      server,
      '?participant=participant-role-owner&name=RoleOwner',
    );
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    const from = publisher.messages.length;
    publisher.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(
      publisher,
      from,
      (message) => message.type === 'role-conflict',
    );
    assert.equal(conflict.currentRole, 'publisher');
    assert.equal(conflict.requestedRole, 'monitor');

    await sendPcmInChunks(publisher, tone(0.35, 0.4));
    const status = await (await fetch(server.httpUrl('/statusz'))).json() as Record<string, any>;
    assert.equal(status.source.micConnected, true);
    assert.equal(status.source.micStreaming, true);
    publisher.close();
  } finally {
    await server.stop();
  }
});

test('playback identity remains orthogonal to the immutable publisher role', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const client = await RelayClient.connect(
      server,
      '?participant=participant-playback-role&name=Playback',
    );
    client.send({
      type: 'playback-hello',
      playbackTransportId: 'playback-role-test',
      playbackGeneration: 1,
    });
    await client.waitForType('playback-registered');

    client.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await client.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    const from = client.messages.length;
    client.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(
      client,
      from,
      (message) => message.type === 'role-conflict',
    );
    assert.equal(conflict.currentRole, 'publisher');
    assert.equal(conflict.requestedRole, 'monitor');
    client.close();
  } finally {
    await server.stop();
  }
});

test('a rejected publisher attempt does not pin an otherwise reusable socket role', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const participant = await RelayClient.connect(
      server,
      '?participant=participant-invalid-role&name=Retry',
    );
    participant.send({ type: 'register', role: 'publisher', sampleRate: 3 });
    await participant.waitForType('error');

    participant.send({ type: 'register', role: 'monitor' });
    const registered = await participant.waitFor(
      (message) => message.type === 'registered' && message.role === 'monitor',
    );
    assert.equal(registered.role, 'monitor');
    participant.close();
  } finally {
    await server.stop();
  }
});
