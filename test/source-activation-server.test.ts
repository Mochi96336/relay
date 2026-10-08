import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startCalibrationCollecting,
  startRelay,
  toInt16,
  waitForNewMessage,
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  // Generous: a calibration has to stay collecting even under a loaded full run.
  RELAY_CALIBRATION_TIMEOUT_MS: '15000',
  RELAY_HEARTBEAT_MS: '60000',
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

const playingStartedAtMs = Date.now();
function playingTelemetry() {
  return {
    type: 'youtube-telemetry',
    videoId: 'dQw4w9WgXcQ',
    state: 1,
    currentTime: 42 + (Date.now() - playingStartedAtMs) / 1_000,
    duration: 200,
    playbackRate: 1,
    networkRttMs: 40,
  };
}

function tone(seconds: number, gain: number) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, 5), gain);
}

/** Sends real-time 20 ms frames, as a live capture would, until stopped. */
function streamLive(client: RelayClient, gain: number) {
  const frame = toInt16(pulseTrain(960, RATE, 5), gain);
  const timer = setInterval(() => client.sendPcm(frame), 20);
  return () => clearInterval(timer);
}

async function timingStatus(monitor: RelayClient) {
  const from = monitor.messages.length;
  monitor.send({ type: 'timing-calibration-status-request' });
  return waitForNewMessage(monitor, from, (message) => message.type === 'timing-calibration-status');
}

test('a newer Desktop Source tab replaces the old one', async () => {
  const server = await startRelay(FAST);
  try {
    const first = await RelayClient.connect(server);
    first.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await first.waitForType('registered');

    const second = await RelayClient.connect(server);
    second.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await second.waitForType('registered');

    const retired = await first.waitFor((message) => message.type === 'error');
    assert.equal(retired.message, 'Replaced by a newer tab capture.');
  } finally {
    await server.stop();
  }
});

test('a Desktop Source that comes back with a new capture during calibration fails it', async () => {
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connect(server);
    const publisher = await RelayClient.connect(server);
    const monitor = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, captureGeneration: 1, captureSampleCursor: 0 });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);
    const prime = async () => {
      publisher.send(playingTelemetry());
      await Promise.all([
        sendPcmInChunks(backing, tone(0.5, 0.8)),
        sendPcmInChunks(publisher, tone(0.5, 0.4)),
      ]);
    };
    await prime();
    await startCalibrationCollecting(publisher, monitor, prime);

    // The tab reloaded: same Desktop Source, a different capture.
    const from = monitor.messages.length;
    const reloaded = await RelayClient.connect(server);
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
    const backing = await RelayClient.connect(server);
    const publisher = await RelayClient.connect(server);
    const monitor = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);
    const first = await RelayClient.connect(server);
    first.send({ type: 'robot-source-hello' });
    stops.push(streamLive(backing, 0.8), streamLive(publisher, 0.4));
    first.send({ type: 'robot-player-offset', offsetMs: 35 });

    // The automatic boot probe asks the phone to play.
    await publisher.waitFor((message) => message.type === 'play-calibration-probe', 5_000);
    const before = await timingStatus(monitor);
    assert.equal(before.probeActive, true);
    assert.equal(Math.round(before.robotPlayerOffsetMs), 35);

    const from = monitor.messages.length;
    const second = await RelayClient.connect(server);
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
