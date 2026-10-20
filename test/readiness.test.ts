import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';
import { playRoomSong, registerPlayback } from './support/client-commands.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
};

function pcm(ms: number) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

test('readyz distinguishes unarmed, robot-host and full live-session readiness', async () => {
  const server = await startRelay(FAST);
  const clients: RelayClient[] = [];
  try {
    let response = await fetch(server.httpUrl('/readyz'));
    assert.equal(response.status, 200);
    let readiness = await response.json() as any;
    assert.equal(readiness.ready, true);
    assert.equal(readiness.sessionReady, false);
    assert.deepEqual(readiness.reasons, []);
    assert.equal(readiness.components.route.mode, 'idle');

    const robot = await RelayClient.connectInfrastructure(server);
    clients.push(robot);
    robot.send({ type: 'robot-source-hello' });
    await sleep(30);

    response = await fetch(server.httpUrl('/readyz'));
    assert.equal(response.status, 503);
    readiness = await response.json() as any;
    assert.equal(readiness.ready, false);
    assert.equal(readiness.components.route.mode, 'robot');
    assert.ok(readiness.reasons.includes('backing-not-connected'));

    const backing = await RelayClient.connectInfrastructure(server);
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
    assert.equal(readiness.components.route.mode, 'robot');
    assert.equal(readiness.components.backing.connected, true);
    assert.equal(readiness.components.backing.streaming, true);
    assert.equal(readiness.components.backing.robot, true);
    assert.equal(readiness.components.robotSource.connected, true);
    assert.equal(readiness.components.calibration.kind, 'none');
    assert.equal(readiness.sessionReady, false);
    assert.ok(readiness.sessionReasons.includes('mic-not-connected'));
    assert.ok(readiness.sessionReasons.includes('phone-timeline-not-connected'));
    assert.ok(readiness.sessionReasons.includes('calibration-missing'));

    const mic = await RelayClient.connectAs(server, 'singer', 'Singer');
    clients.push(mic);
    mic.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await mic.waitForType('registered');
    mic.sendPcm(pcm(40));
    await registerPlayback(mic, 'readiness-playback');
    await playRoomSong(mic);
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

test('readyz does not mistake a development backing client for an armed Robot route', async () => {
  const server = await startRelay(FAST);
  const clients: RelayClient[] = [];
  try {
    const robot = await RelayClient.connectInfrastructure(server);
    clients.push(robot);
    robot.send({ type: 'robot-source-hello' });

    const backing = await RelayClient.connectInfrastructure(server);
    clients.push(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');
    backing.sendPcm(pcm(40));
    await sleep(30);

    const response = await fetch(server.httpUrl('/readyz'));
    assert.equal(response.status, 503);
    const readiness = await response.json() as any;
    assert.equal(readiness.ready, false);
    assert.equal(readiness.components.route.mode, 'robot');
    assert.ok(readiness.reasons.includes('backing-not-robot'));
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});
