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
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
};

const playingTelemetry = {
  type: 'youtube-telemetry',
  videoId: 'dQw4w9WgXcQ',
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
  networkRttMs: 40,
};

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

async function primeStreams(backing: RelayClient, publisher: RelayClient) {
  await Promise.all([
    sendPcmInChunks(backing, tone(0.5, 0.8)),
    sendPcmInChunks(publisher, tone(0.5, 0.4)),
  ]);
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for new message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

async function completeCalibration(
  backing: RelayClient,
  publisher: RelayClient,
  monitor: RelayClient,
  lagMs: number,
) {
  publisher.send(playingTelemetry);
  await primeStreams(backing, publisher);
  await startCalibrationCollecting(publisher, monitor, async () => {
    publisher.send(playingTelemetry);
    await primeStreams(backing, publisher);
  });

  const from = monitor.messages.length;
  const pair = laggedPair(8, RATE, lagMs);
  await Promise.all([
    sendPcmInChunks(backing, pair.backing),
    sendPcmInChunks(publisher, pair.mic),
  ]);
  return waitForNewMessage(
    monitor,
    from,
    (message) => message.type === 'timing-calibration-status' && message.state === 'complete',
    10_000,
  );
}

test('server keeps old confirmed alignment through failed retry and replaces it only on promotion', async () => {
  const server = await startRelay(FAST);
  const backing = await RelayClient.connect(server);
  const publisher = await RelayClient.connect(server);
  const monitor = await RelayClient.connect(server);

  try {
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    await Promise.all([
      backing.waitForType('registered'),
      publisher.waitForType('registered'),
      monitor.waitForType('registered'),
    ]);

    const first = await completeCalibration(backing, publisher, monitor, 260);
    const oldLag = Number(first.micLagMs);
    assert.ok(Number.isFinite(oldLag));
    assert.ok(Math.abs(oldLag - 260) <= 25, `expected first calibration near 260 ms, got ${oldLag}`);
    assert.equal(first.activeMicLagMs, oldLag, 'confirmed result must already be mixer authority');

    publisher.send(playingTelemetry);
    await primeStreams(backing, publisher);
    const retryCollecting = await startCalibrationCollecting(publisher, monitor, async () => {
      publisher.send(playingTelemetry);
      await primeStreams(backing, publisher);
    });
    assert.equal(retryCollecting.micLagMs, oldLag, 'retry keeps the old confirmed result applied');
    assert.equal(retryCollecting.activeMicLagMs, oldLag, 'mixer must not drop old authority while collecting');

    const failureFrom = monitor.messages.length;
    const failed = await waitForNewMessage(
      monitor,
      failureFrom,
      (message) => message.type === 'timing-calibration-status' && message.state === 'failed',
      5_000,
    );
    assert.equal(failed.micLagMs, oldLag, 'failed retry rolls back to the old confirmed result');
    assert.equal(failed.activeMicLagMs, oldLag, 'failed retry must leave the mixer on old confirmed authority');
    assert.equal(failed.provisional, false);

    const promoted = await completeCalibration(backing, publisher, monitor, 420);
    const newLag = Number(promoted.micLagMs);
    assert.ok(Number.isFinite(newLag));
    assert.ok(Math.abs(newLag - 420) <= 25, `expected promoted calibration near 420 ms, got ${newLag}`);
    assert.ok(Math.abs(newLag - oldLag) >= 100, 'replacement evidence must be observably different from old authority');
    assert.equal(promoted.activeMicLagMs, newLag, 'promotion switches mixer authority with the confirmed result');
  } finally {
    backing.close();
    publisher.close();
    monitor.close();
    await server.stop();
  }
});
