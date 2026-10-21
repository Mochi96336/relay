import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, participantIdFor, sleep, startRelay, statusz } from './helpers/harness.js';
import { requestProductStatus } from './support/client-commands.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
};

function pcm(ms: number) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

test('/statusz, /readyz and product-status agree that a completely unarmed room is healthy idle', async () => {
  const server = await startRelay(FAST);
  try {
    const remote = await statusz(server);
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

    const client = await RelayClient.connectAs(server, 'product-user-123', 'Mochi');
    // Ignore an unsolicited idle snapshot queued before this participant joined.
    const product = await requestProductStatus(client, message => message.room?.participantCount === 1);

    assert.equal(product.lifecycle, 'idle');
    assert.equal(product.health, 'healthy');
    assert.equal(product.attention, null);
    assert.deepEqual(product.issues, []);
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
    const robot = await RelayClient.connectInfrastructure(server);
    robot.send({ type: 'robot-source-hello' });
    await sleep(30);

    const remote = await statusz(server);
    assert.equal(remote.ok, false);
    assert.equal(remote.state, 'fault');
    assert.equal(remote.robot.route, true);
    assert.ok(remote.faults.includes('robot route has no backing source'));

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.components.route.mode, 'robot');
    assert.ok(readiness.reasons.includes('backing-not-connected'));

    const observer = await RelayClient.connectAs(server, 'observer-user-123', 'Quiet Cat');
    observer.send({ type: 'product-status-request' });
    const product = await observer.waitForType('product-status');
    assert.equal(product.lifecycle, 'idle');
    assert.equal(product.health, 'blocked');
    assert.deepEqual(product.attention, {
      code: 'robot-audio-unavailable',
      scope: 'robot',
      severity: 'critical',
    });
    assert.equal(product.issues[0].cause, 'backing-not-ready');
    assert.deepEqual(product.issues[0].affects, ['song', 'recording']);
    assert.equal(product.issues[0].recovery, 'automatic');

    observer.close();
    robot.close();
  } finally {
    await server.stop();
  }
});

test('a legacy backing route stays healthy without Robot identity or player delta', async () => {
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connectBacking(server);
    backing.sendPcm(pcm(40));
    await sleep(30);

    const remote = await statusz(server);
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

test('stale Backing catch-up stays transport-streaming but is not product-playable', async () => {
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connectBacking(server);

    // Establish the capture clock, then let the mixer run far beyond its
    // frontier while the socket itself remains connected.
    backing.sendPcm(pcm(40));
    await sleep(750);

    // One queued old frame arrives now. Transport freshness is real, but this
    // frame still belongs near the beginning of the capture and cannot cover
    // the current mix read head.
    backing.sendPcm(pcm(20));
    await sleep(30);

    const observer = await RelayClient.connectAs(server, 'stale-backing-observer', 'Observer');

    observer.send({ type: 'source-status-request' });
    const source = await observer.waitForType('source-status');
    assert.equal(source.backingStreaming, true, 'packet transport is fresh');
    assert.equal(source.backingPlayable, false, 'live mix frontier is still starved');

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.ok(readiness.reasons.includes('backing-not-streaming'));

    observer.send({ type: 'product-status-request' });
    const product = await observer.waitForType('product-status');
    assert.equal(product.health, 'blocked');
    assert.equal(product.issues[0]?.code, 'audio-unavailable');
    assert.equal(product.issues[0]?.cause, 'backing-stalled');

    observer.close();
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
    const backing = await RelayClient.connectBacking(server);
    backing.sendPcm(pcm(40));
    await sleep(30);

    backing.close();
    await sleep(60);

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.components.route.mode, 'legacy');
    assert.ok(readiness.reasons.includes('backing-not-connected'));

    const remote = await statusz(server);
    assert.equal(remote.ok, false);
    assert.equal(remote.state, 'fault');
    assert.equal(remote.robot.route, false);

    const observer = await RelayClient.connectAs(server, 'legacy-observer-123', 'Quiet Cat');
    observer.send({ type: 'product-status-request' });
    const product = await observer.waitForType('product-status');
    assert.equal(product.health, 'blocked');
    assert.deepEqual(product.attention, {
      code: 'audio-unavailable',
      scope: 'audio',
      severity: 'critical',
    });
    assert.equal(product.issues[0].cause, 'backing-unavailable');
    assert.deepEqual(product.issues[0].affects, ['song', 'recording']);
    assert.equal(product.issues[0].recovery, 'host-service');
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
    const robot = await RelayClient.connectInfrastructure(server);
    robot.send({ type: 'robot-source-hello' });

    const backing = await RelayClient.connectBacking(server, { robot: true });
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

    const remote = await statusz(server);
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
    const singer = await RelayClient.connectAs(server, 'singer-user-123', 'Blue Fox');
    singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await singer.waitForType('registered');

    const observer = await RelayClient.connectAs(server, 'observer-user-123', 'Quiet Cat');
    observer.send({ type: 'product-status-request' });
    const product = await observer.waitFor(
      (message) => message.type === 'product-status'
        && message.room?.mic?.ownerId === participantIdFor('singer-user-123'),
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