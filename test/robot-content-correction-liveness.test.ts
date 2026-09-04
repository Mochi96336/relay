import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const INITIAL_CONFIRMED_END = Math.round(RATE * 7.0);
const PRE_LOOP_END = Math.round(RATE * 7.2);
const CORRECTION_INTERVAL_SAMPLES = Math.round(RATE * 0.7);
const FINAL_SETTLE_SAMPLES = Math.round(RATE * 1.0);
const QUEUED_PRE_SEEK_SAMPLES = Math.round(RATE * 0.6);
const POST_PROOF_SAMPLES = Math.round(RATE * 3.0);
const TOTAL_SAMPLES = PRE_LOOP_END
  + CORRECTION_INTERVAL_SAMPLES * 2
  + FINAL_SETTLE_SAMPLES
  + QUEUED_PRE_SEEK_SAMPLES
  + POST_PROOF_SAMPLES;

const source = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');

const PROBE_FAST = {
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '100',
  RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '2',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '1500',
  RELAY_AUTO_CALIBRATE: '1',
  RELAY_AUTO_CALIBRATION_RETRY_MS: '100',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_TIMEOUT_MS: '30000',
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

function makeBackingFrame(
  master: Float64Array,
  startSample: number,
  endSample: number,
  deltaMs: number,
) {
  const advanceSamples = Math.round((RATE * (PATH_LAG_MS + deltaMs)) / 1_000);
  return toInt16(
    master.subarray(startSample + advanceSamples, endSample + advanceSamples),
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

async function waitForTimingStatus(
  monitor: RelayClient,
  predicate: (status: Record<string, any>) => boolean,
  timeoutMs: number,
  from = monitor.messages.length,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    monitor.send({ type: 'timing-calibration-status-request' });
    await sleep(50);
    const statuses = monitor.messages
      .slice(from)
      .filter((message) => message.type === 'timing-calibration-status');
    last = statuses.at(-1) ?? last;
    const match = statuses.find(predicate);
    if (match) return match;
  }
  throw new Error(`Timed out waiting for timing status. Last=${JSON.stringify(last ?? null)}`);
}

async function waitForActiveLag(
  monitor: RelayClient,
  expectedMs: number,
  timeoutMs: number,
  from?: number,
) {
  return waitForTimingStatus(
    monitor,
    (status) => status.calibrationKind === 'content'
      && status.timingMode === 'acoustic-calibration'
      && Math.abs(Number(status.activeMicLagMs) - expectedMs) <= 60,
    timeoutMs,
    from,
  );
}

function backingBoundaryRequestCount(backing: RelayClient) {
  return backing.messages.filter((message) => message.type === 'backing-sample-boundary-request').length;
}

async function acknowledgeNextBackingBoundary(backing: RelayClient, previousCount: number) {
  const deadline = Date.now() + 2_000;
  let request: Record<string, any> | undefined;
  while (!request && Date.now() < deadline) {
    request = backing.messages
      .filter((message) => message.type === 'backing-sample-boundary-request')[previousCount];
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
}

function productionCorrectionCadence() {
  const settleMatch = source.match(/const ROBOT_DELTA_SETTLE_MS = ([0-9_]+);/);
  const intervalMatch = source.match(/now - lastSeekAt > ([0-9_]+)/);
  assert.ok(settleMatch, 'production Source must declare Robot delta settle suppression');
  assert.ok(intervalMatch, 'production Source must declare the follower correction interval');
  return {
    settleMs: Number(settleMatch[1].replaceAll('_', '')),
    correctionIntervalMs: Number(intervalMatch[1].replaceAll('_', '')),
  };
}

test('production follower correction requires server-confirmed transition anchor evidence', () => {
  const { settleMs, correctionIntervalMs } = productionCorrectionCadence();
  assert.equal(settleMs, 1_000);
  assert.equal(correctionIntervalMs, 700);
  assert.ok(correctionIntervalMs < settleMs);
  assert.match(
    source,
    /const shouldSeek = armed[\s\S]*?latestSourceStatus\?\.robotContentTransitionAnchorReady === true[\s\S]*?now - lastSeekAt > 700/,
  );
  assert.match(
    source,
    /if \(ROBOT_MODE && armed\) send\(\{ type: 'source-status-request' \}\);/,
    'Robot Source must refresh readiness at the authoritative timeline cadence',
  );
});

test('repeated 700 ms corrections stay quarantined and recover after the first final fresh offset', async () => {
  const server = await startRelay(PROBE_FAST);
  const room = await robotRoom(server);
  let keepMappingFresh: NodeJS.Timeout | null = null;
  try {
    room.publisher.send(playingTelemetry);

    const maxAdvanceSamples = Math.round((RATE * REFERENCE_LAG_MS) / 1_000);
    // Keep every transition proof window classifiable by the production music
    // matcher. Seed 131 leaves these deterministic 650 ms windows with only two
    // active bands, so it tests the matcher's deliberate fail-closed threshold
    // instead of the repeated-correction liveness contract this case owns.
    const master = pulseTrain(TOTAL_SAMPLES + maxAdvanceSamples + RATE, RATE, 73);
    const mic = toInt16(master.subarray(0, TOTAL_SAMPLES), 0.45, 0.004, 137);

    await sendRange(room, mic, master, 0, FRAME_SAMPLES, INITIAL_DELTA_MS);
    room.robot.send({ type: 'robot-player-offset', offsetMs: INITIAL_DELTA_MS });
    keepMappingFresh = setInterval(() => {
      room.robot.send({ type: 'robot-player-offset', offsetMs: INITIAL_DELTA_MS });
    }, 250);
    await sendRange(room, mic, master, FRAME_SAMPLES, INITIAL_CONFIRMED_END, INITIAL_DELTA_MS);

    const confirmed = await waitForActiveLag(room.monitor, REFERENCE_LAG_MS, 30_000);
    assert.ok(Math.abs(Number(confirmed.micLagMs) - REFERENCE_LAG_MS) <= 60);
    assert.ok(Math.abs(Number(confirmed.activeMicLagMs) - REFERENCE_LAG_MS) <= 60);

    if (keepMappingFresh) clearInterval(keepMappingFresh);
    keepMappingFresh = null;

    await sendRange(
      room,
      mic,
      master,
      INITIAL_CONFIRMED_END,
      PRE_LOOP_END,
      INITIAL_DELTA_MS,
    );

    const boundaryCountBeforeLoop = backingBoundaryRequestCount(room.backing);
    let cursor = PRE_LOOP_END;
    const targets = [100.0, 100.7, 101.4];

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const fromStatus = room.monitor.messages.length;
      room.robot.send({
        type: 'source-seeked',
        reason: 'follower-correction',
        // The Source sees the player 500 ms ahead again at each correction.
        // Because 700 ms < the 1000 ms suppression window, no intervening
        // robot-player-offset packet is possible in the production loop.
        fromMediaTime: target + 0.5,
        toMediaTime: target,
      });

      if (index < targets.length - 1) {
        const next = cursor + CORRECTION_INTERVAL_SAMPLES;
        await sendRange(room, mic, master, cursor, next, 0);
        cursor = next;
        await sleep(725);
      } else {
        const next = cursor + FINAL_SETTLE_SAMPLES;
        await sendRange(room, mic, master, cursor, next, 0);
        cursor = next;
        await sleep(1_050);
      }

      assert.equal(
        backingBoundaryRequestCount(room.backing),
        boundaryCountBeforeLoop,
        'no fresh Robot offset means no backing frontier may be requested during the correction loop',
      );

      const held = await waitForActiveLag(
        room.monitor,
        REFERENCE_LAG_MS,
        3_000,
        fromStatus,
      );
      assert.ok(Math.abs(Number(held.micLagMs) - REFERENCE_LAG_MS) <= 60);
      assert.ok(
        Math.abs(Number(held.activeMicLagMs) - REFERENCE_LAG_MS) <= 60,
        'repeated corrections must not move the old confirmed live authority while content is quarantined',
      );
      assert.equal(held.error ?? null, null);
    }

    // Corrections have finally stopped. Only now can Source escape its 1000 ms
    // suppression window and publish the first fresh player offset. That report
    // must recover from the *last* pending correction rather than inheriting a
    // stale accumulated transition hypothesis from the 700 ms loop.
    const finalBoundaryCount = backingBoundaryRequestCount(room.backing);
    room.robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    await acknowledgeNextBackingBoundary(room.backing, finalBoundaryCount);
    keepMappingFresh = setInterval(() => {
      room.robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    }, 250);

    // The transport frontier still is not a content boundary. Keep the old
    // relation for another 600 ms and prove live authority remains at 750 ms.
    const queuedPreEnd = cursor + QUEUED_PRE_SEEK_SAMPLES;
    await sendRange(room, mic, master, cursor, queuedPreEnd, INITIAL_DELTA_MS);
    cursor = queuedPreEnd;
    const queuedPre = await waitForActiveLag(room.monitor, REFERENCE_LAG_MS, 3_000);
    assert.ok(Math.abs(Number(queuedPre.activeMicLagMs) - REFERENCE_LAG_MS) <= 60);

    // Once actual post-seek content persists, the transition must eventually
    // commit and resume ordinary content timing. A finite correction burst may
    // delay evidence, but it must not leave Relay permanently quarantined.
    const postProofFrom = room.monitor.messages.length;
    await sendRange(room, mic, master, cursor, TOTAL_SAMPLES, 0);

    const recovered = await waitForActiveLag(room.monitor, PATH_LAG_MS, 10_000, postProofFrom);
    assert.ok(
      Math.abs(Number(recovered.micLagMs) - REFERENCE_LAG_MS) <= 60,
      'reference-frame content authority must survive the correction burst',
    );
    assert.ok(
      Math.abs(Number(recovered.activeMicLagMs) - PATH_LAG_MS) <= 60,
      'the first final fresh offset plus post-seek PCM must release quarantine and converge live lag',
    );
    assert.ok(
      Math.abs(Number(recovered.micLagMs) - Number(recovered.activeMicLagMs)) >= 350,
      'recovery must preserve reference authority while committing only the final backing-content mapping',
    );
  } finally {
    if (keepMappingFresh) clearInterval(keepMappingFresh);
    room.close();
    await server.stop();
  }
});