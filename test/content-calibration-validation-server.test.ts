import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  RelayClient,
  laggedPair,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
  type RelayServer,
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '5000',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '1',
  RELAY_CALIBRATION_VALIDATION_INTERVAL_MS: '50',
  RELAY_CALIBRATION_VALIDATION_RETRY_MS: '50',
  RELAY_CALIBRATION_VALIDATION_DEVIATION_MS: '30',
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

async function liveSession(server: RelayServer) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connect(server);
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  return { backing, publisher, monitor };
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

async function primeStreams(backing: RelayClient, publisher: RelayClient) {
  await Promise.all([
    sendPcmInChunks(backing, tone(0.5, 0.8)),
    sendPcmInChunks(publisher, tone(0.5, 0.4)),
  ]);
}

async function establishBaseline(
  backing: RelayClient,
  publisher: RelayClient,
  monitor: RelayClient,
  lagMs = 260,
) {
  publisher.send(playingTelemetry);
  await primeStreams(backing, publisher);
  publisher.send({ type: 'start-timing-calibration' });
  await monitor.waitFor((m) => m.type === 'timing-calibration-status' && m.state === 'collecting');

  const pair = laggedPair(8, RATE, lagMs, 7);
  await Promise.all([
    sendPcmInChunks(backing, pair.backing),
    sendPcmInChunks(publisher, pair.mic),
  ]);

  return monitor.waitFor(
    (m) => m.type === 'timing-calibration-status'
      && m.state === 'complete'
      && m.calibrationKind === 'content',
    10_000,
  );
}

async function waitForValidationCollection(monitor: RelayClient, fromIndex: number) {
  return waitForNewMessage(
    monitor,
    fromIndex,
    (m) => m.type === 'timing-calibration-status'
      && m.validation?.state === 'collecting',
    4_000,
  );
}

describe('continuous content calibration validation server policy', () => {
  test('baseline seed and stable completion are published without a status request', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const baseline = await establishBaseline(backing, publisher, monitor);
      const baselineLag = Number(baseline.micLagMs);
      const afterCalibration = monitor.messages.length;

      const seeded = await waitForNewMessage(
        monitor,
        afterCalibration,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.state === 'waiting'
          && Number.isFinite(Number(m.validation?.baselineLagMs)),
        4_000,
      );
      assert.ok(Math.abs(Number(seeded.validation.baselineLagMs) - baselineLag) < 1);

      const collectingFrom = monitor.messages.length;
      await waitForValidationCollection(monitor, collectingFrom);
      const stableFrom = monitor.messages.length;
      const stablePair = laggedPair(8, RATE, baselineLag, 17);
      await Promise.all([
        sendPcmInChunks(backing, stablePair.backing),
        sendPcmInChunks(publisher, stablePair.mic),
      ]);

      const stable = await waitForNewMessage(
        monitor,
        stableFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.state === 'waiting'
          && m.validation?.lastOutcome === 'stable',
        4_000,
      );
      assert.ok(Math.abs(Number(stable.validation.lastMeasuredLagMs) - baselineLag) <= 30);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('analyser rejection publishes invalid immediately and preserves the baseline', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const baseline = await establishBaseline(backing, publisher, monitor);
      const baselineLag = Number(baseline.micLagMs);
      const collectingFrom = monitor.messages.length;
      await waitForValidationCollection(monitor, collectingFrom);

      const invalidFrom = monitor.messages.length;
      const silence = Buffer.alloc(RATE * 7 * 2);
      await Promise.all([
        sendPcmInChunks(backing, silence),
        sendPcmInChunks(publisher, silence),
      ]);

      const invalid = await waitForNewMessage(
        monitor,
        invalidFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.state === 'waiting'
          && m.validation?.lastOutcome === 'invalid',
        4_000,
      );
      assert.ok(Math.abs(Number(invalid.validation.baselineLagMs) - baselineLag) < 1);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('inconclusive second evidence is published immediately and never changes authority', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const baseline = await establishBaseline(backing, publisher, monitor);
      const baselineLag = Number(baseline.micLagMs);
      const firstStart = monitor.messages.length;
      await waitForValidationCollection(monitor, firstStart);

      const firstDrift = laggedPair(8, RATE, 360, 61);
      const suspectFrom = monitor.messages.length;
      await Promise.all([
        sendPcmInChunks(backing, firstDrift.backing),
        sendPcmInChunks(publisher, firstDrift.mic),
      ]);
      await waitForNewMessage(
        monitor,
        suspectFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.lastOutcome === 'suspect',
        4_000,
      );

      const confirmStart = monitor.messages.length;
      await waitForValidationCollection(monitor, confirmStart);
      const secondDrift = laggedPair(8, RATE, 420, 79);
      const inconclusiveFrom = monitor.messages.length;
      await Promise.all([
        sendPcmInChunks(backing, secondDrift.backing),
        sendPcmInChunks(publisher, secondDrift.mic),
      ]);
      const inconclusive = await waitForNewMessage(
        monitor,
        inconclusiveFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.lastOutcome === 'inconclusive'
          && m.validation?.state === 'waiting',
        4_000,
      );
      assert.ok(Math.abs(Number(inconclusive.validation.baselineLagMs) - baselineLag) < 1);
      assert.ok(Math.abs(Number(inconclusive.activeMicLagMs) - baselineLag) < 1);

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });

  test('single drift evidence cannot move alignment; a second agreeing window slews toward it', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const baseline = await establishBaseline(backing, publisher, monitor);
      const baselineLag = Number(baseline.micLagMs);
      assert.ok(Number.isFinite(baselineLag));

      const firstStart = monitor.messages.length;
      await waitForValidationCollection(monitor, firstStart);

      const firstDrift = laggedPair(8, RATE, 360, 31);
      const suspectFrom = monitor.messages.length;
      await Promise.all([
        sendPcmInChunks(backing, firstDrift.backing),
        sendPcmInChunks(publisher, firstDrift.mic),
      ]);

      const suspect = await waitForNewMessage(
        monitor,
        suspectFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.lastOutcome === 'suspect'
          && m.validation?.suspectLagMs !== null,
        4_000,
      );
      assert.ok(
        Math.abs(Number(suspect.validation.lastMeasuredLagMs) - baselineLag) > 30,
        'first validation should be a real deviation',
      );

      const beforePromotion = monitor.latest('source-status');
      assert.ok(beforePromotion);
      assert.equal(
        Math.round(Number(beforePromotion.activeCalibratedMicLagMs)),
        Math.round(baselineLag),
        'one deviating window must not change mixer alignment',
      );

      const confirmFrom = monitor.messages.length;
      await waitForValidationCollection(monitor, confirmFrom);

      const secondDrift = laggedPair(8, RATE, 355, 47);
      await Promise.all([
        sendPcmInChunks(backing, secondDrift.backing),
        sendPcmInChunks(publisher, secondDrift.mic),
      ]);

      const promoted = await waitForNewMessage(
        monitor,
        confirmFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.lastOutcome === 'drift-confirmed',
        8_000,
      );
      const promotedLag = Number(promoted.micLagMs);
      assert.ok(Math.abs(promotedLag - baselineLag) > 30);

      const promotionSource = await waitForNewMessage(
        monitor,
        confirmFrom,
        (m) => m.type === 'source-status'
          && m.timingMode === 'acoustic-calibration'
          && Math.abs(Number(m.calibratedMicLagMs) - promotedLag) < 1,
        4_000,
      );
      const activeAtPromotion = Number(promotionSource.activeCalibratedMicLagMs);
      assert.ok(
        Math.abs(activeAtPromotion - baselineLag) < Math.abs(promotedLag - baselineLag),
        'validated drift must target the new lag without jumping the applied read head there',
      );
      assert.ok(
        Math.abs(activeAtPromotion - promotedLag) > 5,
        'promotion source status should expose target and still-applied lag separately',
      );

      await sleep(300);
      const progressFrom = monitor.messages.length;
      monitor.send({ type: 'source-status-request' });
      const progress = await waitForNewMessage(
        monitor,
        progressFrom,
        (m) => m.type === 'source-status',
        2_000,
      );
      const activeAfter = Number(progress.activeCalibratedMicLagMs);
      assert.ok(
        Math.abs(promotedLag - activeAfter) < Math.abs(promotedLag - activeAtPromotion),
        'live read head should move toward the validated target over subsequent mix frames',
      );

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});
