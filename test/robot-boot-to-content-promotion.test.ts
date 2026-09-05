import assert from 'node:assert/strict';
import test from 'node:test';

import { generateProbeReference } from '../src/calibration-probe.js';
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

/**
 * The boot -> content promotion path, driven through the real server.
 *
 * #222 redefined a successful boot probe as a fast *baseline* that a playing
 * Song should promote to content authority. That claim was only ever asserted
 * by matching source text inside `maybeAutoCalibrate`, so the three older gates
 * that still implement the opposite policy - content is the boot probe's
 * failure fallback - stayed green:
 *
 *   dropLegacyCalibrationForRobot()   resets content collection every 250 ms
 *   calibrationCanApply()             refuses to apply a confirmed content result
 *   contentValidationPathReady()      never starts drift validation
 *
 * None of those are reachable by regex. They need the scheduler to actually
 * run, so these tests drive a real boot probe to completion and then follow the
 * promotion the whole way to the mixer.
 */

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

const BOOT_ROOM = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '1',
  // One window, so a content result is reachable inside a test run.
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_TIMEOUT_MS: '20000',
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  // Capture frames arrive faster than wall time here; give the detector room to
  // find the exact probe rather than weakening the correlation threshold.
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '1200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0.5',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '5000',
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
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

/**
 * A Robot room whose boot probe has completed successfully, with a Song playing
 * and a fresh player delta - the exact state #222 says must promote to content.
 *
 * The player-offset heartbeat matters: `RobotContentTimelineMapper` only counts
 * as ready while a delta stays fresh, and `maybeAutoCalibrate` refuses to start
 * content against an unmapped Robot route.
 */
async function bootedRobotRoom(server: RelayServer) {
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
    5_000,
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

  const booted = await monitor.waitFor(
    (m) => m.type === 'timing-calibration-status'
      && m.calibrationKind === 'boot-probe'
      && m.state === 'complete',
    8_000,
  );
  assert.equal(booted.probeError, null, 'this fixture requires a *successful* boot probe');

  // A Song plus a fresh player delta is what turns the path-only boot result
  // into applied authority, and what makes content evidence mappable at all.
  publisher.send(PLAYING_TELEMETRY);
  robot.send({ type: 'robot-player-offset', offsetMs: 0 });
  const heartbeat = setInterval(() => {
    robot.send({ type: 'robot-player-offset', offsetMs: 0 });
  }, 200);

  const bootApplied = await monitor.waitFor(
    (m) => m.type === 'timing-calibration-status'
      && m.activeCalibrationKind === 'boot-probe'
      && m.timingMode === 'acoustic-calibration'
      && m.robotDeltaFresh === true,
    5_000,
  );

  return {
    backing,
    publisher,
    robot,
    monitor,
    bootApplied,
    stopHeartbeat() {
      clearInterval(heartbeat);
    },
    close() {
      clearInterval(heartbeat);
      backing.close();
      publisher.close();
      robot.close();
      monitor.close();
    },
  };
}

test('starting the content upgrade does not revoke the applied boot baseline', async () => {
  const server = await startRelay(BOOT_ROOM);
  const room = await bootedRobotRoom(server);
  try {
    assert.equal(room.bootApplied.activeCalibrationKind, 'boot-probe');
    const bootLagMs = Number(room.bootApplied.activeMicLagMs);
    assert.ok(Number.isFinite(bootLagMs));

    const beforeContent = room.monitor.messages.length;
    const music = laggedPair(9, RATE, 30);
    await Promise.all([
      sendPcmInChunks(room.backing, music.backing),
      sendPcmInChunks(room.publisher, music.mic),
    ]);

    await waitForNewMessage(
      room.monitor,
      beforeContent,
      (m) => m.type === 'timing-calibration-status'
        && m.calibrationKind === 'content'
        && m.state === 'collecting',
      8_000,
    );

    // The scheduler runs every 250 ms. `dropLegacyCalibrationForRobot()` still
    // implements the old policy, so it resets the run mid-flight - and because
    // `calibration.reset()` also drops the confirmed result, the applied boot
    // baseline is destroyed as collateral and the mixer falls back to its
    // network estimate. `maybeAutoCalibrate()` restarts content inside the same
    // tick, so an observer never sees `idle`; the visible damage is the applied
    // authority disappearing and collected progress going backwards.
    await sleep(2_000);

    const timeline = room.monitor.messages
      .slice(beforeContent)
      .filter((m) => m.type === 'timing-calibration-status');

    const revoked = timeline.filter((m) => m.activeCalibrationKind === 'none');
    assert.deepEqual(
      revoked.map((m) => `applied=${m.activeCalibrationKind} lag=${m.activeMicLagMs} mode=${m.timingMode}`),
      [],
      'a content upgrade must never revoke the boot baseline it is upgrading from',
    );

    let peakProgress = 0;
    for (const status of timeline) {
      const progress = Number(status.progress) || 0;
      assert.ok(
        progress >= peakProgress - 0.001,
        `collected progress went backwards (${peakProgress.toFixed(2)} -> ${progress.toFixed(2)}):`
        + ' the content run was reset while the boot probe had not failed',
      );
      peakProgress = Math.max(peakProgress, progress);
    }
  } finally {
    room.close();
    await server.stop();
  }
});

test('boot baseline promotes to content authority, reaches the mixer, and arms drift validation', async () => {
  const server = await startRelay({
    ...BOOT_ROOM,
    RELAY_CALIBRATION_VALIDATION: '1',
    RELAY_CALIBRATION_VALIDATION_INTERVAL_MS: '1000',
  });
  const room = await bootedRobotRoom(server);
  try {
    assert.equal(room.bootApplied.activeCalibrationKind, 'boot-probe');

    const beforeContent = room.monitor.messages.length;
    // Enough real audio for one full 6 s content window on both sides.
    const music = laggedPair(9, RATE, 30);
    await Promise.all([
      sendPcmInChunks(room.backing, music.backing),
      sendPcmInChunks(room.publisher, music.mic),
    ]);

    const confirmed = await waitForNewMessage(
      room.monitor,
      beforeContent,
      (m) => m.type === 'timing-calibration-status'
        && m.state === 'complete'
        && m.activeCalibrationKind === 'content',
      15_000,
    );
    assert.equal(
      confirmed.timingMode,
      'acoustic-calibration',
      'a confirmed content result must own the mixer, not sit behind the boot result it replaces',
    );
    assert.notEqual(confirmed.activeMicLagMs, null);

    const applied = await waitForNewMessage(
      room.monitor,
      beforeContent,
      (m) => m.type === 'source-status'
        && m.activeCalibrationKind === 'content'
        && m.timingMode === 'acoustic-calibration',
      5_000,
    );
    assert.notEqual(applied.activeCalibratedMicLagMs, null);

    // Drift validation is the whole point of promoting to content authority.
    // It must not stay gated behind a boot probe failure that never happens.
    const validating = await waitForNewMessage(
      room.monitor,
      beforeContent,
      (m) => m.type === 'timing-calibration-status'
        && m.validation?.baselineLagMs !== null
        && m.validation?.baselineLagMs !== undefined,
      8_000,
    );
    assert.equal(
      Math.round(Number(validating.validation.baselineLagMs)),
      Math.round(Number(confirmed.activeMicLagMs)),
      'the validation baseline must be the content result that is actually applied',
    );
  } finally {
    room.close();
    await server.stop();
  }
});

test('a quiet Robot offset heartbeat holds the measured alignment instead of guessing', async () => {
  const server = await startRelay(BOOT_ROOM);
  const room = await bootedRobotRoom(server);
  try {
    assert.equal(room.bootApplied.timingMode, 'acoustic-calibration');
    const heldLagMs = Number(room.bootApplied.activeMicLagMs);
    assert.ok(Number.isFinite(heldLagMs));

    // The Robot reports its offset a few times a second and goes quiet for
    // ordinary reasons - buffering, the settle window after a seek, a track
    // change. Its position does not teleport while it is quiet, so replacing a
    // measured alignment with the network estimate there is a step the room
    // hears in the middle of a song.
    room.stopHeartbeat();
    const beforeQuiet = room.monitor.messages.length;

    // Wait for the room to actually notice the silence rather than for a fixed
    // delay, so the assertion below is about a genuinely stale heartbeat.
    const stillHeld = await waitForNewMessage(
      room.monitor,
      beforeQuiet,
      (m) => m.type === 'timing-calibration-status' && m.robotDeltaFresh === false,
      8_000,
    );
    assert.equal(
      stillHeld.timingMode,
      'acoustic-calibration',
      'a quiet offset heartbeat must not replace the measurement with an estimate',
    );
    assert.equal(
      Math.round(Number(stillHeld.activeMicLagMs)),
      Math.round(heldLagMs),
      'the held total must be the one that was measured, unchanged',
    );

    await sleep(1_500);
    const fellBack = room.monitor.messages
      .slice(beforeQuiet)
      .filter((m) => m.type === 'source-status' || m.type === 'timing-calibration-status')
      .filter((m) => m.timingMode === 'network-estimate');
    assert.deepEqual(
      fellBack.map((m) => `${m.type} lag=${m.activeCalibratedMicLagMs ?? m.activeMicLagMs}`),
      [],
      'the measurement must stay in force for as long as the heartbeat is quiet',
    );
  } finally {
    room.close();
    await server.stop();
  }
});

test('a seek that invalidates content hands the mixer back to the boot baseline', async () => {
  const server = await startRelay(BOOT_ROOM);
  const room = await bootedRobotRoom(server);
  try {
    const beforeContent = room.monitor.messages.length;
    const music = laggedPair(9, RATE, 30);
    await Promise.all([
      sendPcmInChunks(room.backing, music.backing),
      sendPcmInChunks(room.publisher, music.mic),
    ]);
    const confirmed = await waitForNewMessage(
      room.monitor,
      beforeContent,
      (m) => m.type === 'timing-calibration-status'
        && m.state === 'complete'
        && m.activeCalibrationKind === 'content',
      15_000,
    );
    assert.equal(confirmed.timingMode, 'acoustic-calibration');

    // A discontinuity that cannot be preserved - a load, not a follower
    // correction the mapper can carry forward - advances the source generation
    // and takes content's reference frame with it. The boot probe measured
    // pipeline latency with a known tone, so the seek says nothing about that
    // measurement: it must reclaim the mixer rather than let the room fall to
    // the network estimate.
    const beforeSeek = room.monitor.messages.length;
    room.robot.send({ type: 'source-seeked', reason: 'load' });

    const reclaimed = await waitForNewMessage(
      room.monitor,
      beforeSeek,
      (m) => m.type === 'timing-calibration-status'
        && m.activeCalibrationKind === 'boot-probe'
        && m.timingMode === 'acoustic-calibration',
      10_000,
    );
    assert.notEqual(reclaimed.activeMicLagMs, null);

    const pathDifferenceMs = Number(reclaimed.bootCalibration?.micLatencyMs)
      - Number(reclaimed.bootCalibration?.backingLatencyMs);
    assert.ok(Number.isFinite(pathDifferenceMs));
    assert.ok(
      Math.abs(
        Number(reclaimed.activeMicLagMs)
        - (pathDifferenceMs + Number(reclaimed.bootCalibration?.deltaMs)),
      ) < 1,
      'the reclaimed total must be the measured pipeline latency plus the current delta',
    );
  } finally {
    room.close();
    await server.stop();
  }
});

test('a gross player jump revokes content authority instead of parking it for later reuse', async () => {
  const server = await startRelay(BOOT_ROOM);
  const room = await bootedRobotRoom(server);
  try {
    const beforeContent = room.monitor.messages.length;
    const music = laggedPair(9, RATE, 30);
    await Promise.all([
      sendPcmInChunks(room.backing, music.backing),
      sendPcmInChunks(room.publisher, music.mic),
    ]);

    const confirmed = await waitForNewMessage(
      room.monitor,
      beforeContent,
      (m) => m.type === 'timing-calibration-status'
        && m.state === 'complete'
        && m.activeCalibrationKind === 'content',
      15_000,
    );
    assert.equal(confirmed.calibrationStale, false);

    // The >5 s fence exists to reject telemetry that cannot be an acoustic
    // measurement. Clearing only the tracker and the mapper leaves the
    // confirmed result still matching the live calibration context, so it stays
    // eligible to be re-applied the moment a bounded residual arrives. A
    // fail-closed fence has to invalidate the reference frame.
    room.stopHeartbeat();
    const beforeJump = room.monitor.messages.length;
    room.robot.send({ type: 'robot-player-offset', offsetMs: 190_000 });

    const revoked = await waitForNewMessage(
      room.monitor,
      beforeJump,
      (m) => m.type === 'source-status' && m.timingMode === 'network-estimate',
      4_000,
    );
    assert.equal(revoked.activeCalibratedMicLagMs, null);
    assert.equal(
      revoked.calibrationStale,
      true,
      'the gross-offset fence must invalidate the reference frame, not just the mapping',
    );

    // A bounded residual makes the mapper ready again. The revoked measurement
    // must not come back with it.
    const beforeResidual = room.monitor.messages.length;
    for (let i = 0; i < 8; i += 1) {
      room.robot.send({ type: 'robot-player-offset', offsetMs: 0 });
      await sleep(120);
    }
    const resurrected = room.monitor.messages
      .slice(beforeResidual)
      .filter((m) => m.type === 'source-status')
      .find((m) => Number(m.activeCalibratedMicLagMs) === Number(confirmed.activeMicLagMs));
    assert.equal(
      resurrected,
      undefined,
      'a revoked content result must not be resurrected by a fresh bounded delta',
    );
  } finally {
    room.close();
    await server.stop();
  }
});
