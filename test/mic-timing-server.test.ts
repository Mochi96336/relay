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
  // Generous: these tests need a calibration to finish even under a loaded full run.
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

/** A legacy Mic and Desktop Source with a confirmed content calibration. */
async function calibratedRoom(server: Awaited<ReturnType<typeof startRelay>>) {
  const backing = await RelayClient.connect(server);
  const publisher = await RelayClient.connect(server);
  const monitor = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
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
  const complete = settled;
  return { backing, publisher, monitor, lagMs: Number(complete.micLagMs), activeLagMs: complete.activeMicLagMs };
}

test('a replaced Mic capture keeps the calibration result but stops it driving the mix', async () => {
  const server = await startRelay(FAST);
  try {
    const { monitor, lagMs, activeLagMs } = await calibratedRoom(server);
    assert.equal(activeLagMs, lagMs, 'the result drives the mix');

    const replacement = await RelayClient.connect(server);
    replacement.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 2 });
    await replacement.waitForType('registered');
    await sleep(200);

    const from = monitor.messages.length;
    monitor.send({ type: 'timing-calibration-status-request' });
    const after = await waitForNewMessage(monitor, from, (message) => message.type === 'timing-calibration-status');
    assert.equal(after.state, 'complete', 'the measurement is kept');
    assert.equal(after.micLagMs, lagMs);
    assert.equal(after.calibrationKind, 'content');
    assert.equal(after.activeMicLagMs, null, 'but it was measured on the old capture');
    assert.equal(after.calibrationStale, true);
  } finally {
    await server.stop();
  }
});

test('a new Mic owner starts from no calibration', async () => {
  const server = await startRelay(FAST);
  try {
    const { monitor } = await calibratedRoom(server);

    const alice = await RelayClient.connect(server, '?participant=participant-alice&name=Alice');
    alice.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 7 });
    await alice.waitForType('registered');
    await sleep(200);

    const from = monitor.messages.length;
    monitor.send({ type: 'timing-calibration-status-request' });
    const after = await waitForNewMessage(monitor, from, (message) => message.type === 'timing-calibration-status');
    assert.equal(after.state, 'idle');
    assert.equal(after.micLagMs, null, 'another singer\'s measurement does not carry over');
    assert.equal(after.activeMicLagMs, null);
    assert.equal(after.calibrationKind, 'none');
  } finally {
    await server.stop();
  }
});

test('a new Mic owner during calibration fails it with the reason', async () => {
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connect(server);
    const publisher = await RelayClient.connect(server);
    const monitor = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
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
    const alice = await RelayClient.connect(server, '?participant=participant-alice&name=Alice');
    alice.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 7 });
    const failed = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status' && message.state === 'failed'
    ));
    assert.equal(failed.error, 'Microphone ownership changed.');
  } finally {
    await server.stop();
  }
});

test('a room that stops forgets its calibration', async () => {
  const server = await startRelay({ ...FAST, RELAY_BACKING_GRACE_MS: '250' });
  try {
    const { monitor, backing, publisher } = await calibratedRoom(server);

    // With a Song, a Desktop Source that does not come back stops the room.
    const stopFrom = monitor.messages.length;
    backing.close();
    publisher.close();
    await waitForNewMessage(monitor, stopFrom, (message) => (
      message.type === 'source-status' && message.active === false
    ), 3_000);

    const from = monitor.messages.length;
    monitor.send({ type: 'timing-calibration-status-request' });
    const after = await waitForNewMessage(monitor, from, (message) => message.type === 'timing-calibration-status');
    assert.equal(after.state, 'idle');
    assert.equal(after.micLagMs, null);
    assert.equal(after.calibrationKind, 'none');
  } finally {
    await server.stop();
  }
});
