import assert from 'node:assert/strict';
import test from 'node:test';

import { generateProbeReference } from '../src/calibration-probe.js';
import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
} from './helpers/harness.js';

const RATE = 48_000;
const PLAYING_TELEMETRY = {
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

function probeAudio(leadMs = 20, tailMs = 1_800) {
  const reference = generateProbeReference(RATE);
  const probe = Buffer.alloc(reference.length * 2);
  for (let i = 0; i < reference.length; i += 1) {
    probe.writeInt16LE(reference[i], i * 2);
  }
  return Buffer.concat([
    Buffer.alloc(Math.round((RATE * leadMs) / 1000) * 2),
    probe,
    Buffer.alloc(Math.round((RATE * tailMs) / 1000) * 2),
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

function assertBootUsesDelta(status: Record<string, any>, expectedDeltaMs: number) {
  assert.equal(Math.round(status.robotPlayerOffsetMs), expectedDeltaMs);
  assert.equal(Math.round(status.bootCalibration?.deltaMs), expectedDeltaMs);
  assert.ok(
    Math.abs(Number(status.activeMicLagMs) - Number(status.bootCalibration?.advanceMs)) < 0.001,
    `active lag ${status.activeMicLagMs} must equal boot advance ${status.bootCalibration?.advanceMs}`,
  );
}

test('robot source disconnect suspends the applied delta until a fresh source offset arrives', async () => {
  const server = await startRelay({
    RELAY_LIVE_PREBUFFER_MS: '200',
    RELAY_HEARTBEAT_MS: '60000',
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_PROBE: '1',
    RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
    RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
    // The test sends capture frames faster than wall time. Give the detector
    // enough room to find the exact probe at its framed sample position rather
    // than weakening the production correlation threshold to bypass detection.
    RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '1200',
    RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0.5',
    RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '5000',
  });

  try {
    const backing = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');

    const publisher = await RelayClient.connect(server);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    const monitor = await RelayClient.connect(server);
    monitor.send({ type: 'register', role: 'monitor' });
    await monitor.waitForType('registered');

    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });

    await Promise.all([
      sendPcmInChunks(backing, tone(0.8, 0.8)),
      sendPcmInChunks(publisher, tone(0.8, 0.4)),
    ]);

    const micRequest = await publisher.waitFor(
      (m) => m.type === 'play-calibration-probe' && m.target === 'mic',
      3_000,
    );
    publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: micRequest.requestId,
      generation: publisher.generationId,
    });
    await sendPcmInChunks(publisher, probeAudio());

    const backingRequest = await robot.waitFor(
      (m) => m.type === 'play-calibration-probe' && m.target === 'backing',
      5_000,
    );
    robot.send({
      type: 'calibration-probe-played',
      target: 'backing',
      requestId: backingRequest.requestId,
    });
    await sendPcmInChunks(backing, probeAudio());

    const beforeFirstDelta = monitor.messages.length;
    monitor.send({ type: 'timing-calibration-status-request' });
    const measured = await waitForNewMessage(
      monitor,
      beforeFirstDelta,
      (m) => m.type === 'timing-calibration-status'
        && m.calibrationKind === 'boot-probe'
        && m.state === 'complete',
      5_000,
    );
    assert.equal(measured.timingMode, 'acoustic-calibration');
    assert.equal(measured.robotDeltaFresh, false);
    const measuredPathDifference = Number(measured.bootCalibration?.micLatencyMs)
      - Number(measured.bootCalibration?.backingLatencyMs);
    assert.ok(Number.isFinite(measuredPathDifference));
    assert.ok(
      Math.abs(Number(measured.activeMicLagMs) - measuredPathDifference) < 0.001,
      `path-only boot authority ${measured.activeMicLagMs} must equal measured path difference ${measuredPathDifference}`,
    );
    assert.equal(Math.round(measured.bootCalibration?.deltaMs), 0);
    assert.ok(measured.probeCorrelation.mic >= 0.5);
    assert.ok(measured.probeCorrelation.backing >= 0.5);

    const beforeSong = monitor.messages.length;
    publisher.send(PLAYING_TELEMETRY);
    const awaitingDelta = await waitForNewMessage(
      monitor,
      beforeSong,
      (m) => m.type === 'source-status'
        && m.timingMode === 'network-estimate'
        && m.robotDeltaFresh === false,
      3_000,
    );
    assert.equal(awaitingDelta.activeCalibratedMicLagMs, null,
      'once a Song exists, path-only authority must wait for player-relative delta');

    robot.send({ type: 'robot-player-offset', offsetMs: 80 });
    const firstApplied = await monitor.waitFor(
      (m) => m.type === 'timing-calibration-status'
        && m.timingMode === 'acoustic-calibration'
        && m.robotDeltaFresh === true
        && Math.round(m.robotPlayerOffsetMs) === 80,
      3_000,
    );
    assertBootUsesDelta(firstApplied, 80);

    const probeRequestsBeforeDisconnect = publisher.messages.filter(
      (m) => m.type === 'play-calibration-probe',
    ).length;
    const beforeDisconnect = monitor.messages.length;

    robot.close();
    const suspended = await waitForNewMessage(
      monitor,
      beforeDisconnect,
      (m) => m.type === 'source-status'
        && m.robotSourceConnected === false
        && m.timingMode === 'network-estimate',
      3_000,
    );
    assert.equal(suspended.activeCalibratedMicLagMs, null);
    assert.equal(suspended.calibrationStale, true);
    assert.equal(suspended.robotDeltaFresh, false);

    const replacement = await RelayClient.connect(server);
    replacement.send({ type: 'robot-source-hello' });
    replacement.send({ type: 'robot-player-offset', offsetMs: 35 });

    const restored = await monitor.waitFor(
      (m) => m.type === 'timing-calibration-status'
        && m.timingMode === 'acoustic-calibration'
        && m.robotDeltaFresh === true
        && Math.round(m.robotPlayerOffsetMs) === 35,
      4_000,
    );
    assert.equal(restored.calibrationStale, false);
    assert.equal(restored.calibrationKind, 'boot-probe');
    assertBootUsesDelta(restored, 35);

    await sleep(2_300);
    const beforeExpiryStatus = monitor.messages.length;
    monitor.send({ type: 'source-status-request' });
    const expired = await waitForNewMessage(
      monitor,
      beforeExpiryStatus,
      (m) => m.type === 'source-status' && m.robotDeltaFresh === false,
      3_000,
    );
    assert.equal(expired.robotSourceConnected, true, 'the source socket itself is still alive');
    assert.equal(expired.timingMode, 'network-estimate');
    assert.equal(expired.activeCalibratedMicLagMs, null);
    assert.equal(expired.calibrationStale, false, 'the measured path is still valid; only delta expired');

    replacement.send({ type: 'robot-player-offset', offsetMs: 25 });
    const resumed = await monitor.waitFor(
      (m) => m.type === 'timing-calibration-status'
        && m.timingMode === 'acoustic-calibration'
        && m.robotDeltaFresh === true
        && Math.round(m.robotPlayerOffsetMs) === 25,
      4_000,
    );
    assertBootUsesDelta(resumed, 25);

    await sleep(300);
    const probeRequestsAfterReconnect = publisher.messages.filter(
      (m) => m.type === 'play-calibration-probe',
    ).length;
    assert.equal(probeRequestsAfterReconnect, probeRequestsBeforeDisconnect);

    replacement.close();
    backing.close();
    publisher.close();
    monitor.close();
  } finally {
    await server.stop();
  }
});
