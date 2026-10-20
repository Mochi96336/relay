import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  startCalibrationCollecting,
  startRelay,
  toInt16,
  tone,
  waitForNewMessage,
} from './helpers/harness.js';
import { playingRoomSong, timingStatus } from './support/client-commands.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  // Generous: a calibration has to stay collecting even under a loaded full run.
  RELAY_CALIBRATION_TIMEOUT_MS: '15000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
};
const ROBOT = {
  ...FAST,
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
};

/** Sends real-time 20 ms frames, as a live capture would, until stopped. */
function streamLive(client: RelayClient, gain: number) {
  const frame = toInt16(pulseTrain(960, RATE, 5), gain);
  const timer = setInterval(() => client.sendPcm(frame), 20);
  return () => clearInterval(timer);
}

test('a newer Desktop Source tab replaces the old one', async () => {
  const server = await startRelay(FAST);
  try {
    const first = await RelayClient.connectBacking(server);

    const second = await RelayClient.connectBacking(server);

    const retired = await first.waitFor((message) => message.type === 'error');
    assert.equal(retired.message, 'Replaced by a newer tab capture.');
  } finally {
    await server.stop();
  }
});

test('a Desktop Source that comes back with a new capture during calibration fails it', async () => {
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connectInfrastructure(server);
    const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
    const monitor = await RelayClient.connectAs(server, 'listener', 'Listener');
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, captureGeneration: 1, captureSampleCursor: 0 });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);
    const songTelemetry = await playingRoomSong(publisher);
    const prime = async () => {
      publisher.send(songTelemetry());
      await Promise.all([
        sendPcmInChunks(backing, tone(0.5, 0.8)),
        sendPcmInChunks(publisher, tone(0.5, 0.4)),
      ]);
    };
    await prime();
    await startCalibrationCollecting(publisher, monitor, prime);

    // The tab reloaded: same Desktop Source, a different capture.
    const from = monitor.messages.length;
    const reloaded = await RelayClient.connectInfrastructure(server);
    reloaded.send({ type: 'register', role: 'backing', sampleRate: RATE, captureGeneration: 2, captureSampleCursor: 0 });
    await reloaded.waitForType('registered');

    const failed = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status' && message.state === 'failed'
    ));
    assert.equal(failed.error, 'Backing capture restarted during calibration. Start calibration again.');
  } finally {
    await server.stop();
  }
});

test('a Robot that replaces another mid probe abandons the probe and starts without its delta', async () => {
  const server = await startRelay(ROBOT);
  const stops: Array<() => void> = [];
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
    const first = await RelayClient.connectInfrastructure(server);
    first.send({ type: 'robot-source-hello' });
    stops.push(streamLive(backing, 0.8), streamLive(publisher, 0.4));
    first.send({ type: 'robot-player-offset', offsetMs: 35 });

    // The automatic boot probe asks the phone to play.
    await publisher.waitFor((message) => message.type === 'play-calibration-probe', 5_000);
    const before = await timingStatus(monitor);
    assert.equal(before.probeActive, true);
    assert.equal(Math.round(before.robotPlayerOffsetMs), 35);

    const from = monitor.messages.length;
    const second = await RelayClient.connectInfrastructure(server);
    second.send({ type: 'robot-source-hello' });
    await first.waitForType('robot-source-replaced');

    // The status the activation publishes: the old Robot's probe and delta
    // are gone before the new Robot has said anything.
    const sourceIndex = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'source-status' && message.robotSourceConnected === true
    ), 1_000).then((message) => monitor.messages.indexOf(message));
    const after = await waitForNewMessage(monitor, sourceIndex + 1, (message) => (
      message.type === 'timing-calibration-status'
    ), 1_000);
    assert.equal(after.probeActive, false, 'the probe was measuring the Robot that left');
    assert.equal(after.robotPlayerOffsetMs, null, 'the new Robot brings its own delta');
  } finally {
    for (const stop of stops) stop();
    await server.stop();
  }
});
