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
const INITIAL_CONFIRMED_END = Math.round(RATE * 7.0);
const PRE_SEEK_LIVE_END = Math.round(RATE * 7.2);
const QUEUED_PRE_SEEK_END = Math.round(RATE * 7.8);
// The transition verifier deliberately discards an ambiguous 650 ms window and
// waits for an independent one. Give it multiple pure post-seek windows after
// the mixed boundary instead of making one content window a hidden test oracle.
const TOTAL_SAMPLES = Math.round(RATE * 10.6);

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

async function waitForActiveLag(monitor: RelayClient, expectedMs: number, timeoutMs: number, from?: number) {
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

test('confirmed Robot content keeps pre-seek live lag until post-seek PCM commits the segment', async () => {
  const server = await startRelay(PROBE_FAST);
  const room = await robotRoom(server);
  let keepMappingFresh: NodeJS.Timeout | null = null;
  try {
    room.publisher.send(playingTelemetry);

    const maxAdvanceSamples = Math.round((RATE * REFERENCE_LAG_MS) / 1_000);
    const master = pulseTrain(TOTAL_SAMPLES + maxAdvanceSamples + RATE, RATE, 73);
    const mic = toInt16(master.subarray(0, TOTAL_SAMPLES), 0.45, 0.004, 79);

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
      PRE_SEEK_LIVE_END,
      INITIAL_DELTA_MS,
    );

    const afterSeekFrom = room.monitor.messages.length;
    room.robot.send({
      type: 'source-seeked',
      reason: 'follower-correction',
      fromMediaTime: 100.5,
      toMediaTime: 100,
    });

    const immediatelyAfterSeek = await waitForActiveLag(
      room.monitor,
      REFERENCE_LAG_MS,
      3_000,
      afterSeekFrom,
    );
    assert.ok(
      Math.abs(Number(immediatelyAfterSeek.activeMicLagMs) - REFERENCE_LAG_MS) <= 60,
      'player control must not move the live Mic read head before backing content changes',
    );

    const boundaryCount = backingBoundaryRequestCount(room.backing);
    room.robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    await acknowledgeNextBackingBoundary(room.backing, boundaryCount);
    keepMappingFresh = setInterval(() => {
      room.robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    }, 250);

    await sendRange(
      room,
      mic,
      master,
      PRE_SEEK_LIVE_END,
      QUEUED_PRE_SEEK_END,
      INITIAL_DELTA_MS,
    );
    const queuedOldContent = await waitForActiveLag(room.monitor, REFERENCE_LAG_MS, 3_000);
    assert.ok(
      Math.abs(Number(queuedOldContent.activeMicLagMs) - REFERENCE_LAG_MS) <= 60,
      'transport order alone must not grant post-seek live authority',
    );

    const beforePostProof = room.monitor.messages.length;
    await sendRange(
      room,
      mic,
      master,
      QUEUED_PRE_SEEK_END,
      TOTAL_SAMPLES,
      0,
    );

    const committed = await waitForActiveLag(room.monitor, PATH_LAG_MS, 8_000, beforePostProof);
    assert.ok(Math.abs(Number(committed.micLagMs) - REFERENCE_LAG_MS) <= 60);
    assert.ok(
      Math.abs(Number(committed.activeMicLagMs) - PATH_LAG_MS) <= 60,
      'the live mixer may rebase only after post-seek PCM wins the content hypothesis',
    );
    assert.ok(
      Math.abs(Number(committed.micLagMs) - Number(committed.activeMicLagMs)) >= 350,
      'reference authority must remain stable while live authority follows the committed content segment',
    );
  } finally {
    if (keepMappingFresh) clearInterval(keepMappingFresh);
    room.close();
    await server.stop();
  }
});
