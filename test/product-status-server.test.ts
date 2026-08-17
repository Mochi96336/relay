import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

function pcm(ms: number) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

test('/statusz, /readyz and product-status agree that a completely unarmed room is healthy idle', async () => {
  const server = await startRelay(FAST);
  try {
    const remote = await (await fetch(server.httpUrl('/statusz'))).json() as any;
    assert.equal(remote.ok, true);
    assert.equal(remote.state, 'idle');

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 200);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.ready, true);
    assert.equal(readiness.sessionReady, false);
    assert.deepEqual(readiness.reasons, []);
    assert.equal(readiness.components.route.mode, 'idle');
    assert.ok(readiness.sessionReasons.includes('mic-not-connected'));

    const client = await RelayClient.connect(
      server,
      '?participant=product-user-123&name=Mochi',
    );
    client.send({ type: 'product-status-request' });
    const product = await client.waitForType('product-status');

    assert.equal(product.lifecycle, 'idle');
    assert.equal(product.health, 'healthy');
    assert.equal(product.attention, null);
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

test('arming the Robot source makes missing Robot audio a blocker everywhere', async () => {
  const server = await startRelay(FAST);
  try {
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    await sleep(30);

    const remote = await (await fetch(server.httpUrl('/statusz'))).json() as any;
    assert.equal(remote.ok, false);
    assert.equal(remote.state, 'fault');
    assert.equal(remote.robot.route, true);
    assert.ok(remote.faults.includes('robot route has no backing source'));

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.components.route.mode, 'robot');
    assert.ok(readiness.reasons.includes('backing-not-connected'));

    const observer = await RelayClient.connect(
      server,
      '?participant=observer-user-123&name=Quiet%20Cat',
    );
    observer.send({ type: 'product-status-request' });
    const product = await observer.waitForType('product-status');
    assert.equal(product.lifecycle, 'idle');
    assert.equal(product.health, 'blocked');
    assert.deepEqual(product.attention, {
      code: 'robot-audio-unavailable',
      scope: 'robot',
      severity: 'critical',
    });

    observer.close();
    robot.close();
  } finally {
    await server.stop();
  }
});

test('a legacy backing route stays healthy without Robot identity or player delta', async () => {
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');
    backing.sendPcm(pcm(40));
    await sleep(30);

    const remote = await (await fetch(server.httpUrl('/statusz'))).json() as any;
    assert.equal(remote.ok, true);
    assert.equal(remote.state, 'live');
    assert.equal(remote.robot.route, false);

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 200);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.ready, true);
    assert.equal(readiness.components.route.mode, 'legacy');
    assert.equal(readiness.reasons.includes('backing-not-robot'), false);
    assert.equal(readiness.reasons.includes('robot-source-not-connected'), false);

    backing.close();
  } finally {
    await server.stop();
  }
});

test('legacy route expectation survives backing grace instead of collapsing to idle', async () => {
  const server = await startRelay({
    ...FAST,
    RELAY_BACKING_GRACE_MS: '250',
  });
  try {
    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');
    backing.sendPcm(pcm(40));
    await sleep(30);

    backing.close();
    await sleep(60);

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.components.route.mode, 'legacy');
    assert.ok(readiness.reasons.includes('backing-not-connected'));

    const remote = await (await fetch(server.httpUrl('/statusz'))).json() as any;
    assert.equal(remote.ok, false);
    assert.equal(remote.state, 'fault');
    assert.equal(remote.robot.route, false);

    const observer = await RelayClient.connect(
      server,
      '?participant=legacy-observer-123&name=Quiet%20Cat',
    );
    observer.send({ type: 'product-status-request' });
    const product = await observer.waitForType('product-status');
    assert.equal(product.health, 'blocked');
    assert.deepEqual(product.attention, {
      code: 'audio-unavailable',
      scope: 'audio',
      severity: 'critical',
    });
    observer.close();
  } finally {
    await server.stop();
  }
});

test('Robot route expectation survives simultaneous source loss during backing grace', async () => {
  const server = await startRelay({
    ...FAST,
    RELAY_CALIBRATION_PROBE: '0',
    RELAY_BACKING_GRACE_MS: '250',
  });
  try {
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });

    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');
    backing.sendPcm(pcm(40));
    await sleep(30);

    backing.close();
    robot.close();
    await sleep(60);

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.components.route.mode, 'robot');
    assert.ok(readiness.reasons.includes('backing-not-connected'));
    assert.ok(readiness.reasons.includes('robot-source-not-connected'));

    const remote = await (await fetch(server.httpUrl('/statusz'))).json() as any;
    assert.equal(remote.ok, false);
    assert.equal(remote.state, 'fault');
    assert.equal(remote.robot.route, true);
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
    singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
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
    assert.equal(product.room.mic.state, 'starting');
    assert.equal(product.room.participantCount, 2);
    assert.equal('playbackTransportId' in product.room.mic, false);

    singer.close();
    observer.close();
  } finally {
    await server.stop();
  }
});