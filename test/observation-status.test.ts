import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { RelayClient, sleep, startRelay, type RelayServer } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
};

describe('observation status v1', () => {
  let server: RelayServer;
  before(async () => { server = await startRelay(FAST); });
  after(async () => { await server.stop(); });

  const status = async () => (await fetch(server.httpUrl('/api/status/v1'))).json();

  test('treats an idle Relay as normal rather than broken', async () => {
    const body = await status();
    assert.equal(body.schema, 'relay.observation.v1');
    assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
    assert.equal(body.workload.id, 'relay');
    assert.equal(body.workload.state, 'idle');
    assert.equal(body.workload.ok, true);
    assert.equal(body.activity.sessionActive, false);
    assert.deepEqual(body.activity.participants, { total: 0, connected: 0 });
    assert.deepEqual(body.activity.microphoneLease, { held: false, transportConnected: false });
    assert.deepEqual(body.issues, { faults: [], warnings: [] });
  });

  test('publishes anonymous aggregate presence and lease state only', async () => {
    const participantId = 'participant01';
    const nickname = 'Visible Name';
    const publisher = await RelayClient.connect(
      server,
      `?participant=${participantId}&name=${encodeURIComponent(nickname)}`,
    );
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    const body = await status();
    assert.equal(body.activity.participants.total, 1);
    assert.equal(body.activity.participants.connected, 1);
    assert.equal(body.activity.microphoneLease.held, true);
    assert.equal(body.activity.microphoneLease.transportConnected, true);
    assert.equal(body.sources.microphone.connected, true);
    assert.equal(body.sources.microphone.sampleRate, RATE);

    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, new RegExp(participantId));
    assert.doesNotMatch(serialized, new RegExp(nickname));
    assert.doesNotMatch(serialized, /micOwnerId|nickname|participantId/);

    publisher.close();
    await sleep(100);
  });
});
