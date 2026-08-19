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

describe('continuous content calibration validation server policy', () => {
  test('single drift evidence cannot move alignment; a second agreeing window can', async () => {
    const server = await startRelay(FAST);
    try {
      const { backing, publisher, monitor } = await liveSession(server);
      const baseline = await establishBaseline(backing, publisher, monitor);
      const baselineLag = Number(baseline.micLagMs);
      assert.ok(Number.isFinite(baselineLag));

      const firstStart = monitor.messages.length;
      await waitForNewMessage(
        monitor,
        firstStart,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.state === 'collecting',
        4_000,
      );

      const firstDrift = laggedPair(8, RATE, 360, 31);
      await Promise.all([
        sendPcmInChunks(backing, firstDrift.backing),
        sendPcmInChunks(publisher, firstDrift.mic),
      ]);

      const suspectFrom = monitor.messages.length;
      const suspect = await waitForNewMessage(
        monitor,
        Math.max(firstStart, suspectFrom - 4),
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
      monitor.send({ type: 'timing-calibration-status-request' });
      await waitForNewMessage(
        monitor,
        confirmFrom,
        (m) => m.type === 'timing-calibration-status'
          && m.validation?.state === 'collecting'
          && m.validation?.suspectLagMs !== null,
        4_000,
      );

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
      assert.ok(Math.abs(Number(promoted.micLagMs) - baselineLag) > 30);

      const source = await waitForNewMessage(
        monitor,
        confirmFrom,
        (m) => m.type === 'source-status'
          && m.timingMode === 'acoustic-calibration'
          && Math.abs(Number(m.activeCalibratedMicLagMs) - Number(promoted.micLagMs)) < 1,
        4_000,
      );
      assert.equal(
        Math.round(Number(source.activeCalibratedMicLagMs)),
        Math.round(Number(promoted.validation.lastMeasuredLagMs)),
        'confirmed drift promotes the newest agreeing measurement',
      );

      backing.close();
      publisher.close();
      monitor.close();
    } finally {
      await server.stop();
    }
  });
});
