import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sleep,
  startRelay,
  toInt16,
  type RelayServer,
} from './helpers/harness.js';

/**
 * A Take deliberately freezes the mixer alignment for the whole recording,
 * because moving the Mic read head mid-take splices the voice audibly. The
 * mapping underneath is not frozen: the Robot player keeps drifting against the
 * room, and `syncAppliedCalibration()` is refused for the duration.
 *
 * Nothing else in the quality policy witnesses that. The measurement stays
 * valid, so `calibrationStale` is false; the Robot keeps reporting, so
 * `robotDeltaFresh` is true; no transport changes, so no instability event
 * fires. Before this evidence existed the room could record a WAV known to be
 * hundreds of milliseconds out of alignment and still publish it as `clean`.
 */

const RATE = 48_000;
const FRAME_SAMPLES = Math.round(RATE * 0.02);
const PATH_LAG_MS = 120;
const INITIAL_DELTA_MS = 150;
const REFERENCE_LAG_MS = PATH_LAG_MS + INITIAL_DELTA_MS;
/** Well past the 40 ms the mixer itself treats as a real delta movement. */
const DRIFTED_DELTA_MS = 550;
const MASTER_SECONDS = 60;
const VIDEO = 'dQw4w9WgXcQ';

const FAST = {
  // Turning the audible boot probe off leaves the Robot route itself intact, so
  // this room goes straight to content authority. That is also the behavioural
  // half of ARCHITECTURE_BOUNDARIES.md section 7: a strategy flag may not
  // decide whether the room is on a Robot route.
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_AUTO_CALIBRATE: '1',
  RELAY_AUTO_CALIBRATION_RETRY_MS: '100',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_TIMEOUT_MS: '30000',
  RELAY_HEARTBEAT_MS: '60000',
  // Let the smoothing median follow a sustained drift inside the test rather
  // than over the production two-second window.
  RELAY_ROBOT_OFFSET_WINDOW_MS: '300',
  // Deliberately not the default: the Take policy must take its tolerance from
  // the mixer's own re-apply threshold, which deployments tune. The Pi runs 150.
  RELAY_CALIBRATION_DELTA_REAPPLY_MS: '150',
};

const playing = {
  type: 'youtube-telemetry',
  videoId: VIDEO,
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
};

type Room = {
  backing: RelayClient;
  singer: RelayClient;
  robot: RelayClient;
  monitor: RelayClient;
  close: () => void;
};

/**
 * The real product path: a participant owns playback, drives the Song through
 * room-song commands, and only then publishes microphone audio. Telemetry from
 * a participant that skipped the command handshake is refused, so a shortcut
 * here would silently test a room that never reaches content authority.
 */
async function robotRoom(server: RelayServer): Promise<Room> {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
  await backing.waitForType('registered');

  const singer = await RelayClient.connect(server, '?participant=singer-1&name=Singer');

  const robot = await RelayClient.connect(server);
  robot.send({ type: 'robot-source-hello' });

  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  singer.send({ type: 'playback-hello', playbackTransportId: 'singer-playback', playbackGeneration: 1 });
  await singer.waitForType('playback-registered');

  singer.send({
    type: 'room-song-command',
    commandId: 'load-singer-take',
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: playing.currentTime,
  });
  await singer.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'load-singer-take');
  singer.send({ ...playing, state: 5 });
  await singer.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'load-singer-take');

  singer.send({
    type: 'room-song-command',
    commandId: 'play-singer-take',
    expectedRevision: 1,
    action: 'play',
  });
  await singer.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'play-singer-take');
  singer.send(playing);
  await singer.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'play-singer-take');

  singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await singer.waitFor((m) => m.type === 'registered' && m.role === 'publisher');

  return {
    backing,
    singer,
    robot,
    monitor,
    close() {
      monitor.close();
      robot.close();
      singer.close();
      backing.close();
    },
  };
}

/**
 * Streams both captures, the Robot heartbeat and Source telemetry at roughly
 * real time.
 *
 * Bursting the measurement window and stopping leaves both streams outside the
 * liveness horizon and lets the room timeline age out; automatic content
 * calibration then correctly refuses to measure audio nobody is producing.
 */
function startRoomStream(room: Room, master: Float64Array, mic: Buffer) {
  const state = { deltaMs: INITIAL_DELTA_MS, cursor: 0, tick: 0 };
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const start = state.cursor;
    const end = start + FRAME_SAMPLES;
    const advanceSamples = Math.round((RATE * (PATH_LAG_MS + state.deltaMs)) / 1_000);
    room.backing.sendPcm(toInt16(master.subarray(start + advanceSamples, end + advanceSamples), 0.9));
    room.singer.sendPcm(mic.subarray(start * 2, end * 2));
    state.cursor = end;

    state.tick += 1;
    if (state.tick % 5 === 0) {
      room.robot.send({ type: 'robot-player-offset', offsetMs: state.deltaMs });
    }
    if (state.tick % 25 === 0) {
      room.singer.send({
        ...playing,
        currentTime: playing.currentTime + (Date.now() - startedAt) / 1_000,
      });
    }
  }, 20);
  return {
    driftTo(deltaMs: number) { state.deltaMs = deltaMs; },
    stop() { clearInterval(timer); },
  };
}

async function waitForContentAuthority(monitor: RelayClient, expectedMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const from = monitor.messages.length;
  let last: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    monitor.send({ type: 'timing-calibration-status-request' });
    await sleep(50);
    const statuses = monitor.messages
      .slice(from)
      .filter((message) => message.type === 'timing-calibration-status');
    last = statuses.at(-1) ?? last;
    const match = statuses.find((status) => status.calibrationKind === 'content'
      && status.timingMode === 'acoustic-calibration'
      && Math.abs(Number(status.activeMicLagMs) - expectedMs) <= 60);
    if (match) return match;
  }
  throw new Error(`Timed out waiting for content authority. Last=${JSON.stringify(last ?? null)}`);
}

test('a Take whose Robot mapping drifts under its frozen alignment is not published as clean', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-divergence-'));
  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });
  const room = await robotRoom(server);
  let stream: { driftTo: (ms: number) => void; stop: () => void } | null = null;
  try {
    const advanceSamples = Math.round((RATE * (PATH_LAG_MS + DRIFTED_DELTA_MS)) / 1_000);
    const totalSamples = RATE * MASTER_SECONDS;
    const master = pulseTrain(totalSamples + advanceSamples + RATE, RATE, 73);
    const mic = toInt16(master.subarray(0, totalSamples), 0.45, 0.004, 137);

    room.robot.send({ type: 'robot-player-offset', offsetMs: INITIAL_DELTA_MS });
    stream = startRoomStream(room, master, mic);

    const confirmed = await waitForContentAuthority(room.monitor, REFERENCE_LAG_MS, 45_000);
    const appliedAtStart = Number(confirmed.activeMicLagMs);

    room.singer.send({ type: 'start-take' });
    const accepted = await room.singer.waitFor((message) => (
      message.type === 'take-command-accepted' && message.command === 'start'
    ), 10_000);
    const takeId = String(accepted.takeId);

    // The player drifts away from the room while the recording holds its
    // alignment. This is ordinary Robot behaviour, not a fault: nothing here
    // invalidates the measurement or touches a transport.
    stream.driftTo(DRIFTED_DELTA_MS);
    await sleep(2_500);

    room.singer.send({ type: 'stop-take', takeId });
    const ready = await room.singer.waitFor((message) => (
      message.type === 'take-status'
      && message.lifecycle === 'ready'
      && message.take?.takeId === takeId
    ), 15_000);

    const quality = ready.take.quality;
    const codes = quality.issues.map((issue: { code: string }) => issue.code);

    assert.equal(
      Number(quality.evidence.calibrationStaleMs),
      0,
      'a preserved mapping must not be reported as a stale calibration',
    );
    assert.ok(
      quality.evidence.timingDivergedMs > 0,
      `expected recorded divergence, got ${JSON.stringify(quality.evidence)}`,
    );
    assert.equal(
      quality.evidence.timingDivergenceToleranceMs,
      150,
      'the Take policy must apply the mixer configured threshold, not a constant of its own',
    );
    assert.ok(
      quality.evidence.peakTimingDivergenceMs >= 150,
      `expected a peak past the mixer own re-apply threshold, got ${quality.evidence.peakTimingDivergenceMs}`,
    );
    assert.ok(
      codes.includes('timing-diverged'),
      `expected a timing-diverged issue, got ${codes.join(',')}`,
    );
    assert.notEqual(quality.verdict, 'clean');

    // The drift is charged at its real size rather than as a flag.
    assert.equal(
      Math.round(quality.evidence.peakTimingDivergenceMs),
      DRIFTED_DELTA_MS - INITIAL_DELTA_MS,
    );

    // None of the signals a reader would expect to catch this actually fire:
    // the measurement stayed valid, the Robot kept reporting, and the mixer
    // never fell back. That is precisely why the divergence needs its own
    // evidence rather than being inferable from what was already recorded.
    assert.equal(Number(quality.evidence.robotDeltaMissingMs), 0);
    assert.equal(Number(quality.evidence.networkEstimateMs), 0);
    assert.equal(quality.evidence.events['robot-source-replaced'], 0);
    assert.equal(quality.evidence.events['backing-capture-restarted'], 0);

    // The divergence is desired-minus-applied, so a non-zero reading is itself
    // proof the recording held `appliedAtStart` while the mapping moved on.
    assert.ok(Number.isFinite(appliedAtStart));
  } finally {
    stream?.stop();
    room.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
