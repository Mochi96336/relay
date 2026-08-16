import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

function pcm(ms: number) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

test('readyz distinguishes robot-host readiness from full live-session readiness', async () => {
  const server = await startRelay(FAST);
  const clients: RelayClient[] = [];
  try {
    let response = await fetch(server.httpUrl('/readyz'));
    assert.equal(response.status, 503);
    let readiness = await response.json() as any;
    assert.equal(readiness.ready, false);
    assert.equal(readiness.sessionReady, false);
    assert.ok(readiness.reasons.includes('backing-not-connected'));
    assert.ok(readiness.reasons.includes('robot-source-not-connected'));

    const robot = await RelayClient.connect(server);
    clients.push(robot);
    robot.send({ type: 'robot-source-hello' });

    const backing = await RelayClient.connect(server);
    clients.push(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');
    backing.sendPcm(pcm(40));
    await sleep(30);

    response = await fetch(server.httpUrl('/readyz'));
    assert.equal(response.status, 200);
    readiness = await response.json() as any;
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.reasons, []);
    assert.equal(readiness.components.backing.connected, true);
    assert.equal(readiness.components.backing.streaming, true);
    assert.equal(readiness.components.backing.robot, true);
    assert.equal(readiness.components.robotSource.connected, true);
    assert.equal(readiness.components.calibration.kind, 'none');
    assert.equal(readiness.sessionReady, false);
    assert.ok(readiness.sessionReasons.includes('mic-not-connected'));
    assert.ok(readiness.sessionReasons.includes('phone-timeline-not-connected'));
    assert.ok(readiness.sessionReasons.includes('calibration-missing'));

    const mic = await RelayClient.connect(server);
    clients.push(mic);
    mic.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await mic.waitForType('registered');
    mic.sendPcm(pcm(40));
    mic.send({
      type: 'youtube-telemetry',
      videoId: 'dQw4w9WgXcQ',
      state: 1,
      currentTime: 42,
      duration: 200,
      playbackRate: 1,
      networkRttMs: 40,
    });
    robot.send({ type: 'robot-player-offset', offsetMs: 12 });
    await sleep(30);

    readiness = await (await fetch(server.httpUrl('/readyz'))).json() as any;
    assert.equal(readiness.ready, true);
    assert.equal(readiness.components.mic.connected, true);
    assert.equal(readiness.components.mic.streaming, true);
    assert.equal(readiness.components.player.timelineConnected, true);
    assert.equal(readiness.components.player.offsetFresh, true);
    assert.equal(readiness.components.player.offsetMs, 12);
    assert.equal(readiness.sessionReady, false, 'calibration is still deliberately absent');
    assert.deepEqual(readiness.sessionReasons, ['calibration-missing']);
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});

test('readyz does not mistake a development backing client for the robot route', async () => {
  const server = await startRelay(FAST);
  const clients: RelayClient[] = [];
  try {
    const robot = await RelayClient.connect(server);
    clients.push(robot);
    robot.send({ type: 'robot-source-hello' });

    const backing = await RelayClient.connect(server);
    clients.push(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');
    backing.sendPcm(pcm(40));
    await sleep(30);

    const response = await fetch(server.httpUrl('/readyz'));
    assert.equal(response.status, 503);
    const readiness = await response.json() as any;
    assert.equal(readiness.ready, false);
    assert.ok(readiness.reasons.includes('backing-not-robot'));
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});
