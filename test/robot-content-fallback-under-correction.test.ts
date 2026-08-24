import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sleep,
  startRelay,
  toInt16,
  type RelayServer,
} from './helpers/harness.js';

const RATE = 48_000;
const FRAME_SAMPLES = Math.round(RATE * 0.02);
const PATH_LAG_MS = 250;
const INITIAL_DELTA_MS = 500;
const REFERENCE_LAG_MS = PATH_LAG_MS + INITIAL_DELTA_MS;
const POST_PROOF_SAMPLES = Math.round(RATE * 8.5);
const TOTAL_SAMPLES = Math.round(RATE * 15.5);

/**
 * This regression models the actual production discontinuity, not merely
 * the `source-seeked` event. Before correction the Robot is 500 ms ahead,
 * so captured backing content produces a 750 ms raw Mic/backing lag. A
 * follower seek then jumps the backing MEDIA CONTENT backward by 500 ms,
 * making the live raw lag 250 ms while capture sample indices keep moving.
 *
 * Relay must preserve source/capture identity but map those two PCM segments
 * onto their real media-time coordinates. The analyzer may keep a stable
 * 750 ms reference-frame result; the live mixer must end at 250 ms.
 */

const PROBE_FAST = {
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '100',
  RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '2',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '1500',
  RELAY_AUTO_CALIBRATE: '1',
  RELAY_AUTO_CALIBRATION_RETRY_MS: '100',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_TIMEOUT_MS: '20000',
  RELAY_HEARTBEAT_MS: '60000',
};

const playingTelemetry = {
  type: 'youtube-telemetry',
  videoId: 'dQw4w9WgXcQ',
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
};

type Session = {
  backing: RelayClient;
  publisher: RelayClient;
  robot: RelayClient;
  monitor: RelayClient;
  close: () => void;
};

async function robotRoom(server: RelayServer): Promise<Session> {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connect(server);
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const robot = await RelayClient.connect(server);
  robot.send({ type: 'robot-source-hello' });

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  return {
    backing,
    publisher,
    robot,
    monitor,
    close() {
      monitor.close();
      robot.close();
      publisher.close();
      backing.close();
    },
  };
}

async function waitForCalibrationStatus(
  monitor: RelayClient,
  predicate: (status: Record<string, any>) => boolean,
  timeoutMs: number,
) {
  const from = monitor.messages.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    monitor.send({ type: 'timing-calibration-status-request' });
    await sleep(20);
    const status = monitor.messages
      .slice(from)
      .reverse()
      .find((message) => message.type === 'timing-calibration-status' && predicate(message));
    if (status) return status;
  }
  throw new Error(
    `Timed out waiting for fresh calibration status. Saw: ${monitor.messages.slice(from).map((m) => m.type).join(', ')}`,
  );
}

async function waitForEvidenceEpochRestart(
  monitor: RelayClient,
  from: number,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = monitor.messages
      .slice(from)
      .find((message) => (
        message.type === 'timing-calibration-status'
        && message.calibrationKind === 'content'
        && message.state === 'collecting'
        && Number(message.progress) === 0
        && message.timingMode !== 'acoustic-calibration'
      ));
    if (status) return status;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for fresh evidence-epoch restart. Saw: ${monitor.messages.slice(from).map((m) => `${m.type}:${m.state ?? ''}:${m.progress ?? ''}`).join(', ')}`,
  );
}

async function waitForAcousticCalibration(monitor: RelayClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 'nothing';
  while (Date.now() < deadline) {
    const from = monitor.messages.length;
    monitor.send({ type: 'timing-calibration-status-request' });
    await sleep(100);
    const status = monitor.messages
      .slice(from)
      .reverse()
      .find((message) => message.type === 'timing-calibration-status');
    if (status) {
      lastSeen = `state=${status.state} kind=${status.calibrationKind}`
        + ` progress=${Math.round((Number(status.progress) || 0) * 100)}%`
        + ` timingMode=${status.timingMode}`
        + ` error=${status.error ?? 'none'}`;
      if (status.timingMode === 'acoustic-calibration') return status;
    }
  }
  throw new Error(`Timing never became acoustic within ${timeoutMs} ms. Last: ${lastSeen}`);
}

function makeBackingFrame(
  master: Float64Array,
  startSample: number,
  endSample: number,
  deltaMs: number,
) {
  const mediaAdvanceSamples = Math.round((RATE * (PATH_LAG_MS + deltaMs)) / 1_000);
  return toInt16(
    master.subarray(startSample + mediaAdvanceSamples, endSample + mediaAdvanceSamples),
    0.9,
  );
}

async function sendRange(
  room: Session,
  mic: Buffer,
  master: Float64Array,
  startSample: number,
  endSample: number,
  deltaMs: number,
) {
  let frames = 0;
  for (let start = startSample; start < endSample; start += FRAME_SAMPLES) {
    const end = Math.min(endSample, start + FRAME_SAMPLES);
    room.backing.sendPcm(makeBackingFrame(master, start, end, deltaMs));
    room.publisher.sendPcm(mic.subarray(start * 2, end * 2));
    frames += 1;
    if (frames % 25 === 0) await sleep(0);
  }
}

function backingBoundaryRequestCount(backing: RelayClient) {
  return backing.messages.filter((message) => message.type === 'backing-sample-boundary-request').length;
}

async function acknowledgeNextBackingBoundary(backing: RelayClient, previousCount: number) {
  const deadline = Date.now() + 2_000;
  let request: Record<string, any> | undefined;
  while (!request && Date.now() < deadline) {
    const requests = backing.messages.filter(
      (message) => message.type === 'backing-sample-boundary-request',
    );
    request = requests[previousCount];
    if (!request) await sleep(10);
  }
  if (!request) throw new Error('Relay never requested a fresh backing sample boundary.');

  backing.send({
    type: 'backing-sample-boundary',
    requestId: request.requestId,
    generation: backing.generationId,
    firstSampleIndex: backing.cursor,
  });
  await sleep(20);
  return request;
}

test('Robot content fallback maps real follower seeks and applies the post-correction lag', async () => {
  const server = await startRelay(PROBE_FAST);
  const room = await robotRoom(server);
  let keepMappingFresh: NodeJS.Timeout | null = null;
  try {
    room.publisher.send(playingTelemetry);

    const maxAdvanceSamples = Math.round((RATE * REFERENCE_LAG_MS) / 1_000);
    const master = pulseTrain(TOTAL_SAMPLES + maxAdvanceSamples + RATE, RATE, 7);
    const mic = toInt16(master.subarray(0, TOTAL_SAMPLES), 0.45, 0.004, 11);

    // Establish the reference media mapping before any backup evidence is
    // eligible. In this frame, raw content correlation is 250 + 500 = 750 ms.
    await sendRange(room, mic, master, 0, FRAME_SAMPLES, INITIAL_DELTA_MS);
    room.robot.send({ type: 'robot-player-offset', offsetMs: INITIAL_DELTA_MS });
    await sleep(30);
    await sendRange(room, mic, master, FRAME_SAMPLES, RATE * 4, INITIAL_DELTA_MS);

    await room.monitor.waitFor(
      (message) => message.type === 'timing-calibration-status'
        && message.state === 'failed'
        && message.probePhase === 'failed',
      10_000,
    );

    const collecting = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      5_000,
    );
    assert.equal(collecting.state, 'collecting');
    assert.ok(Number(collecting.progress) < 1);
    assert.notEqual(collecting.timingMode, 'acoustic-calibration');

    // Still +500 ms: reference-frame backing coordinates are unchanged.
    await sendRange(room, mic, master, RATE * 4, Math.round(RATE * 4.7), INITIAL_DELTA_MS);
    const beforeFirst = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      2_000,
    );
    assert.equal(beforeFirst.state, 'collecting');

    // Real backward seek: subsequent backing PCM is now 500 ms earlier in
    // song time even though its capture sample cursor continues forward.
    room.robot.send({
      type: 'source-seeked',
      reason: 'follower-correction',
      fromMediaTime: 100.5,
      toMediaTime: 100,
    });
    await sleep(100);
    const afterFirst = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      2_000,
    );
    assert.equal(afterFirst.state, 'collecting');
    assert.notEqual(afterFirst.timingMode, 'acoustic-calibration');

    // Deliberately deliver PCM after the control seek but before any settled
    // post-seek Robot offset. In production this is exactly the PipeWire / two-
    // WebSocket race: these frames may still have been queued under the old
    // mapping and therefore cannot become calibration evidence.
    const firstBoundaryCount = backingBoundaryRequestCount(room.backing);
    const firstProgress = Number(afterFirst.progress);
    await sendRange(room, mic, master, Math.round(RATE * 4.7), Math.round(RATE * 4.8), 0);
    assert.equal(
      backingBoundaryRequestCount(room.backing),
      firstBoundaryCount,
      'Relay must wait for fresh settled player evidence before asking the PCM socket for a frontier',
    );
    const firstQuarantined = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      2_000,
    );
    assert.equal(firstQuarantined.state, 'collecting');
    assert.equal(
      Number(firstQuarantined.progress),
      firstProgress,
      'ambiguous cross-socket PCM must not advance content collection',
    );

    // Model the follower becoming +500 ms ahead again before a second real
    // correction. The first fresh post-seek offset is also what authorizes Relay
    // to request an ordered cursor from the backing PCM transport.
    room.robot.send({ type: 'robot-player-offset', offsetMs: INITIAL_DELTA_MS });
    await acknowledgeNextBackingBoundary(room.backing, firstBoundaryCount);
    await sendRange(
      room,
      mic,
      master,
      Math.round(RATE * 4.8),
      Math.round(RATE * 5.4),
      INITIAL_DELTA_MS,
    );
    const beforeSecond = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      2_000,
    );
    assert.equal(beforeSecond.state, 'collecting');

    room.robot.send({
      type: 'source-seeked',
      reason: 'follower-correction',
      fromMediaTime: 101,
      toMediaTime: 100.5,
    });
    await sleep(100);
    const afterSecond = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      2_000,
    );
    assert.equal(afterSecond.state, 'collecting');
    assert.notEqual(afterSecond.timingMode, 'acoustic-calibration');

    const secondBoundaryCount = backingBoundaryRequestCount(room.backing);
    const secondProgress = Number(afterSecond.progress);
    await sendRange(room, mic, master, Math.round(RATE * 5.4), Math.round(RATE * 5.5), 0);
    assert.equal(backingBoundaryRequestCount(room.backing), secondBoundaryCount);
    const secondQuarantined = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      2_000,
    );
    assert.equal(secondQuarantined.state, 'collecting');
    assert.equal(Number(secondQuarantined.progress), secondProgress);

    // The first fresh player report can only ask the backing transport for a
    // lower-bound cursor. It cannot prove that Browser/PipeWire/parec have
    // already drained the old YouTube content to that cursor.
    room.robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    await acknowledgeNextBackingBoundary(room.backing, secondBoundaryCount);
    keepMappingFresh = setInterval(() => {
      room.robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    }, 250);

    // Adversarial production ordering: the bridge ACKed its sampleCursor, but
    // 600 ms of pre-seek audio was still queued upstream and arrives afterward.
    // These frames retain the old +500 ms raw relationship and must remain
    // quarantined until the audio content itself proves the post-seek segment.
    await sendRange(
      room,
      mic,
      master,
      Math.round(RATE * 5.5),
      Math.round(RATE * 6.1),
      INITIAL_DELTA_MS,
    );
    const afterQueuedPreSeek = await waitForCalibrationStatus(
      room.monitor,
      (status) => status.calibrationKind === 'content',
      2_000,
    );
    assert.equal(afterQueuedPreSeek.state, 'collecting');
    assert.notEqual(afterQueuedPreSeek.timingMode, 'acoustic-calibration');
    assert.equal(
      Number(afterQueuedPreSeek.progress),
      secondProgress,
      'a transport cursor must not relabel queued pre-seek content as post-seek evidence',
    );

    // Only now does the actual post-seek music emerge from the capture pipeline.
    // Capture freshness BEFORE sending enough post content to let the async
    // transition worker prove and commit the current segment. The unique 0%
    // collecting broadcast is emitted by restartWorkingEvidence().
    const restartStatusFrom = room.monitor.messages.length;
    await sendRange(
      room,
      mic,
      master,
      Math.round(RATE * 6.1),
      POST_PROOF_SAMPLES,
      0,
    );
    const afterEvidenceEpochRestart = await waitForEvidenceEpochRestart(
      room.monitor,
      restartStatusFrom,
      5_000,
    );
    assert.equal(afterEvidenceEpochRestart.state, 'collecting');
    assert.equal(Number(afterEvidenceEpochRestart.progress), 0);
    assert.notEqual(afterEvidenceEpochRestart.timingMode, 'acoustic-calibration');

    // Seven raw seconds after the restart provide comfortably more than the
    // six shared reference-frame seconds needed by the unchanged analyzer.
    await sendRange(room, mic, master, POST_PROOF_SAMPLES, TOTAL_SAMPLES, 0);

    const settled = await waitForAcousticCalibration(room.monitor, 30_000);
    assert.equal(settled.timingMode, 'acoustic-calibration');
    assert.ok(
      Math.abs(Number(settled.micLagMs) - REFERENCE_LAG_MS) <= 60,
      `reference-frame lag should stay near ${REFERENCE_LAG_MS} ms, got ${settled.micLagMs}`,
    );
    assert.ok(
      Math.abs(Number(settled.activeMicLagMs) - PATH_LAG_MS) <= 60,
      `live lag must follow the post-correction ${PATH_LAG_MS} ms alignment, got ${settled.activeMicLagMs}`,
    );
    assert.ok(
      Math.abs(Number(settled.micLagMs) - Number(settled.activeMicLagMs)) >= 350,
      'the test must prove reference authority is rebased instead of applying stale pre-seek lag directly',
    );
  } finally {
    if (keepMappingFresh) clearInterval(keepMappingFresh);
    room.close();
    await server.stop();
  }
});
