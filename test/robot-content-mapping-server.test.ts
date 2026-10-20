import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, pulseTrain, sleep, startRelay, toInt16, waitForNewMessage } from './helpers/harness.js';
import { completeRoomSongCommand, playingRoomSong } from './support/client-commands.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
};

async function timingStatus(monitor: RelayClient) {
  const from = monitor.messages.length;
  monitor.send({ type: 'timing-calibration-status-request' });
  return waitForNewMessage(monitor, from, (message) => message.type === 'timing-calibration-status');
}

test('a Robot player that jumps away from the room timeline loses its delta, then starts over', async () => {
  const server = await startRelay(FAST);
  let feed: NodeJS.Timeout | undefined;
  try {
    const backing = await RelayClient.connectInfrastructure(server);
    const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
    const monitor = await RelayClient.connectAs(server, 'listener', 'Listener');
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);
    const robot = await RelayClient.connectInfrastructure(server);
    robot.send({ type: 'robot-source-hello' });
    const frame = toInt16(pulseTrain(960, RATE, 5), 0.5);
    feed = setInterval(() => {
      backing.sendPcm(frame);
      publisher.sendPcm(frame);
    }, 20);
    await playingRoomSong(publisher);

    robot.send({ type: 'robot-player-offset', offsetMs: 35 });
    await sleep(200);
    assert.equal(Math.round((await timingStatus(monitor)).robotPlayerOffsetMs), 35);

    // Minutes away from the room: a convergence problem, not a timing
    // measurement. The whole reference frame is void.
    const from = monitor.messages.length;
    robot.send({ type: 'robot-player-offset', offsetMs: 10_000_000 });
    await waitForNewMessage(monitor, from, (message) => message.type === 'source-status', 1_000);
    const revoked = await timingStatus(monitor);
    assert.equal(revoked.robotPlayerOffsetMs, null);
    assert.equal(revoked.robotDeltaFresh, false);

    // The next sane delta builds a new mapping.
    robot.send({ type: 'robot-player-offset', offsetMs: 40 });
    await sleep(200);
    assert.equal(Math.round((await timingStatus(monitor)).robotPlayerOffsetMs), 40);
  } finally {
    if (feed) clearInterval(feed);
    await server.stop();
  }
});

test('a room playback rate change rebuilds the Robot mapping', async () => {
  const server = await startRelay(FAST);
  let feed: NodeJS.Timeout | undefined;
  try {
    const backing = await RelayClient.connectInfrastructure(server);
    const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
    const monitor = await RelayClient.connectAs(server, 'listener', 'Listener');
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);
    const robot = await RelayClient.connectInfrastructure(server);
    robot.send({ type: 'robot-source-hello' });
    const frame = toInt16(pulseTrain(960, RATE, 5), 0.5);
    feed = setInterval(() => {
      backing.sendPcm(frame);
      publisher.sendPcm(frame);
    }, 20);
    const songTelemetry = await playingRoomSong(publisher);
    robot.send({ type: 'robot-player-offset', offsetMs: 35 });
    await sleep(200);
    assert.equal(Math.round((await timingStatus(monitor)).robotPlayerOffsetMs), 35);

    // Deltas were converted to wall time at 1x; at 1.25x they mean something else.
    await completeRoomSongCommand(
      publisher,
      { commandId: 'rate-1.25', expectedRevision: 2, action: 'rate', playbackRate: 1.25 },
      { ...songTelemetry(), playbackRate: 1.25 },
    );
    await sleep(200);
    const rebuilt = await timingStatus(monitor);
    assert.equal(rebuilt.robotPlayerOffsetMs, null);
  } finally {
    if (feed) clearInterval(feed);
    await server.stop();
  }
});
