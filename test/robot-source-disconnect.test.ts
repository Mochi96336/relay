import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
} from './helpers/harness.js';

const RATE = 48_000;

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
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

test('robot source disconnect suspends the applied delta until a fresh source offset arrives', async () => {
  const server = await startRelay({
    RELAY_LIVE_PREBUFFER_MS: '200',
    RELAY_HEARTBEAT_MS: '60000',
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_PROBE: '1',
    RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
    RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
    RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
    // The state-machine contract is under test, not detector quality. Any
    // deterministic window can stand in for a heard probe here.
    RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '-2',
    RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '3000',
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
    await sendPcmInChunks(publisher, tone(1.5, 0.4));

    const backingRequest = await robot.waitFor(
      (m) => m.type === 'play-calibration-probe' && m.target === 'backing',
      4_000,
    );
    robot.send({
      type: 'calibration-probe-played',
      target: 'backing',
      requestId: backingRequest.requestId,
    });
    await sendPcmInChunks(backing, tone(1.5, 0.8));

    // The two path legs may finish before playback has a stable player offset.
    // Their result is evidence, not a complete three-term alignment: unknown
    // delta must never be silently treated as zero.
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
    assert.equal(measured.timingMode, 'network-estimate');
    assert.equal(measured.activeMicLagMs, null);
    assert.equal(measured.robotDeltaFresh, false);

    // Only a fresh active-player delta completes the equation and grants the
    // boot measurement authority over the mixer.
    robot.send({ type: 'robot-player-offset', offsetMs: 80 });
    await monitor.waitFor(
      (m) => m.type === 'timing-calibration-status'
        && m.timingMode === 'acoustic-calibration'
        && m.robotDeltaFresh === true
        && Math.round(m.robotPlayerOffsetMs) === 80,
      3_000,
    );

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

    // A page can freeze without its WebSocket closing. Once the last offset is
    // older than the freshness budget, it is no longer timing evidence and the
    // mixer must withdraw the boot alignment on its own.
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
    await monitor.waitFor(
      (m) => m.type === 'timing-calibration-status'
        && m.timingMode === 'acoustic-calibration'
        && m.robotDeltaFresh === true
        && Math.round(m.robotPlayerOffsetMs) === 25,
      4_000,
    );

    // Player/socket churn and delta expiry change only delta. The two measured
    // path legs must be reused rather than making the phone beep again.
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
