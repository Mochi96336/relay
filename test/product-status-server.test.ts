import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, startRelay } from './helpers/harness.js';

const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

test('/readyz and product-status share the formal Robot readiness boundary', async () => {
  const server = await startRelay(FAST);
  try {
    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.ready, false);
    assert.equal(readiness.sessionReady, false);
    assert.ok(readiness.reasons.includes('backing-not-connected'));
    assert.ok(readiness.reasons.includes('robot-source-not-connected'));
    assert.ok(readiness.sessionReasons.includes('mic-not-connected'));

    const client = await RelayClient.connect(
      server,
      '?participant=product-user-123&name=Mochi',
    );
    client.send({ type: 'product-status-request' });
    const product = await client.waitForType('product-status');

    assert.equal(product.lifecycle, 'idle');
    assert.equal(product.health, 'blocked');
    assert.deepEqual(product.attention, {
      code: 'robot-audio-unavailable',
      scope: 'robot',
      severity: 'critical',
    });
    assert.equal(product.room.participantCount, 1);
    assert.equal(product.room.mic.state, 'free');
    assert.equal(product.room.song.state, 'empty');
    assert.equal(product.actions.canStartTake, false);
    assert.equal(product.actions.canStopTake, false);
    client.close();
  } finally {
    await server.stop();
  }
});

test('product-status carries person-facing Mic ownership instead of exposing transport identity', async () => {
  const server = await startRelay(FAST);
  try {
    const singer = await RelayClient.connect(
      server,
      '?participant=singer-user-123&name=Blue%20Fox',
    );
    singer.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    await singer.waitForType('registered');

    const observer = await RelayClient.connect(
      server,
      '?participant=observer-user-123&name=Quiet%20Cat',
    );
    observer.send({ type: 'product-status-request' });
    const product = await observer.waitFor(
      (message) => message.type === 'product-status'
        && message.room?.mic?.ownerId === 'singer-user-123',
    );

    assert.equal(product.room.mic.ownerNickname, 'Blue Fox');
    assert.equal(product.room.mic.state, 'reconnecting');
    assert.equal(product.room.participantCount, 2);
    assert.equal('playbackTransportId' in product.room.mic, false);

    singer.close();
    observer.close();
  } finally {
    await server.stop();
  }
});
