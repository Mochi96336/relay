import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  laggedPair,
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
  // Generous: a calibration has to finish even under a loaded full run.
  RELAY_CALIBRATION_TIMEOUT_MS: '15000',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
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

test('a content calibration from the desktop route does not survive the room becoming Robot', async () => {
  // The drop only applies while a Robot boot probe is the room's strategy.
  const server = await startRelay({ ...FAST, RELAY_CALIBRATION_PROBE: '1' });
  try {
    const backing = await RelayClient.connect(server);
    const publisher = await RelayClient.connect(server);
    const monitor = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
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
    const from = monitor.messages.length;
    const pair = laggedPair(8, RATE, 260);
    await Promise.all([
      sendPcmInChunks(backing, pair.backing),
      sendPcmInChunks(publisher, pair.mic),
    ]);
    const settled = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status'
      && (message.state === 'complete' || message.state === 'failed')
    ), 20_000);
    assert.equal(settled.state, 'complete', `calibration did not complete: ${settled.error}`);
    assert.equal(settled.calibrationKind, 'content');

    // The Robot takes over the Source. The desktop measurement was taken
    // over a different path and must not keep driving the Robot room.
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    await monitor.waitFor((message) => message.type === 'source-status' && message.robotSourceConnected === true);
    await sleep(200);

    const after = await timingStatus(monitor);
    assert.notEqual(after.calibrationKind, 'content');
    assert.equal(after.micLagMs, null);
    assert.equal(after.activeMicLagMs, null);
  } finally {
    await server.stop();
  }
});

const ROBOT = {
  ...FAST,
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
};

test('a manual recalibration on the Robot route starts a fresh probe run after one ran out', async () => {
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
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    // A probe starts only while both legs are streaming.
    stops.push(streamLive(backing, 0.8), streamLive(publisher, 0.4));
    await sleep(500);

    // The phone cannot play the automatic probe, three times over.
    let answered = 0;
    let status = await timingStatus(monitor);
    const deadline = Date.now() + 10_000;
    while (!(status.probeActive === false && status.probeError) && Date.now() < deadline) {
      const requests = publisher.messages.filter((message) => message.type === 'play-calibration-probe');
      for (const request of requests.slice(answered)) {
        publisher.send({
          type: 'calibration-probe-failed',
          target: request.target,
          requestId: request.requestId,
          generation: publisher.generationId,
          reason: 'test: cannot play',
        });
        answered += 1;
      }
      await sleep(100);
      status = await timingStatus(monitor);
    }
    assert.match(String(status.probeError), /failed after 3 attempts/);
    assert.equal(status.automatic, true, 'that run was the automatic one');

    const from = monitor.messages.length;
    publisher.send({ type: 'start-timing-calibration' });
    const fresh = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status' && message.probeActive === true
    ), 3_000);
    assert.equal(fresh.calibrationKind, 'boot-probe');
    assert.equal(fresh.automatic, false, 'this one was asked for');
    assert.equal(fresh.probePhase, 'mic-requested');
    assert.equal(fresh.probeActive, true);
    assert.equal(fresh.probeError, null, 'the exhausted run is behind us');
    assert.deepEqual(fresh.probeAttempts, { mic: 1, backing: 0 });
  } finally {
    for (const stop of stops) stop();
    await server.stop();
  }
});
