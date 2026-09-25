import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { MicClockDriftEstimator } from '../src/mic-clock-drift-estimator.js';

const RATE = 48_000;
const CHUNK = 960;
const NETWORK_MS = 50;

function makeSession() {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.setMicGainDb(0);
  session.start(0);
  session.setMicExpected(true);
  session.setAlignment({ calibratedMicLagMs: 150 });
  return session;
}

function toneChunk(firstSampleIndex: number, generation = 7) {
  const pcm = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < CHUNK; i += 1) {
    const n = firstSampleIndex + i;
    pcm.writeInt16LE(Math.round(8_000 * Math.sin((2 * Math.PI * 220 * n) / RATE)), i * 2);
  }
  return { generation, firstSampleIndex, pcm };
}

let seed = 11;
function jitterMs() {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
  return ((seed >>> 16) / 65_536) * 20;
}

/**
 * A phone capture clock `ppm` slow (positive) or fast (negative), wired the
 * way server.ts wires it: every positioned packet feeds the estimator, and a
 * closed window re-reads the estimate into the session.
 */
function runPhone(ppm: number, seconds: number) {
  const session = makeSession();
  const estimator = new MicClockDriftEstimator();
  const phoneRate = RATE * (1 - ppm * 1e-6);
  let cursor = 0;
  let largestStep = 0;
  let previous: number | null = null;
  const headroomAt = new Map<number, number>();
  const minimumHeadroom = (fromMs: number, toMs: number) => Math.min(
    ...[...headroomAt].filter(([atMs]) => atMs >= fromMs && atMs < toMs).map(([, value]) => value),
  );
  let trimStartedAtMs: number | null = null;

  for (let nowMs = 0; nowMs <= seconds * 1_000; nowMs += 5) {
    while (((cursor + CHUNK) / phoneRate) * 1_000 + NETWORK_MS <= nowMs) {
      const arrivedAtMs = ((cursor + CHUNK) / phoneRate) * 1_000 + NETWORK_MS + jitterMs();
      session.ingestMic(toneChunk(cursor), RATE, arrivedAtMs);
      if (estimator.observe(7, RATE, cursor + CHUNK, arrivedAtMs)) {
        session.setMicClockTrimPpm(estimator.estimate()?.ppm ?? null);
        if (trimStartedAtMs === null && session.micClockTrimPpm !== 0) trimStartedAtMs = nowMs;
      }
      cursor += CHUNK;
    }
    session.drain((output) => {
      for (let index = 0; index < output.byteLength / 2; index += 1) {
        const value = output.readInt16LE(index * 2);
        if (previous !== null) largestStep = Math.max(largestStep, Math.abs(value - previous));
        previous = value;
      }
      headroomAt.set(nowMs, session.liveMicHeadroomMs ?? 0);
    }, nowMs);
  }
  return { session, largestStep, minimumHeadroom, trimStartedAtMs };
}

for (const ppm of [300, -300]) {
  test(`a ${ppm > 0 ? 'slow' : 'fast'} ${Math.abs(ppm)} ppm phone clock no longer walks the Mic timeline`, () => {
    const seconds = 300;
    const { session, largestStep, minimumHeadroom, trimStartedAtMs } = runPhone(ppm, seconds);

    assert.ok(trimStartedAtMs !== null && trimStartedAtMs < 90_000, 'the trim starts once the estimate settles');
    assert.ok(
      Math.abs(session.micClockTrimPpm - ppm) < 30,
      `trimming for ${session.micClockTrimPpm} ppm, the clock is ${ppm}`,
    );
    const trimmedSeconds = seconds - trimStartedAtMs! / 1_000;
    const expectedSamples = (ppm * 1e-6) * RATE * trimmedSeconds;
    assert.ok(
      Math.abs(session.micClockTrimSamples - expectedSamples) < Math.abs(expectedSamples) * 0.2,
      `trimmed ${session.micClockTrimSamples} samples, about ${Math.round(expectedSamples)} were owed`,
    );

    // Untrimmed, this clock moves the live headroom by 300 ppm: 66 ms over
    // the trimmed span measured here.
    const early = minimumHeadroom(trimStartedAtMs! + 10_000, trimStartedAtMs! + 20_000);
    const late = minimumHeadroom((seconds - 10) * 1_000, seconds * 1_000);
    assert.ok(
      Math.abs(late - early) < 15,
      `the live headroom still walked from ${early.toFixed(1)} to ${late.toFixed(1)} ms`,
    );
    assert.equal(session.micFrontierCorrectionMs, 0);
    // A 220 Hz tone at 8000 moves at most about 230 per sample.
    assert.ok(largestStep < 400, `trimming stepped the voice by ${largestStep}`);
  });
}

test('an estimate inside the estimator error, or far beyond any clock, is bounded', () => {
  const session = makeSession();
  session.setMicClockTrimPpm(12);
  assert.equal(session.micClockTrimPpm, 0);
  session.setMicClockTrimPpm(-14.9);
  assert.equal(session.micClockTrimPpm, 0);
  session.setMicClockTrimPpm(40);
  assert.equal(session.micClockTrimPpm, 40);
  session.setMicClockTrimPpm(9_000);
  assert.equal(session.micClockTrimPpm, 500);
  session.setMicClockTrimPpm(-9_000);
  assert.equal(session.micClockTrimPpm, -500);
  session.setMicClockTrimPpm(Number.NaN);
  assert.equal(session.micClockTrimPpm, 0);
  session.setMicClockTrimPpm(null);
  assert.equal(session.micClockTrimPpm, 0);
});

test('a new capture clock starts untrimmed', () => {
  const session = makeSession();
  session.ingestMic(toneChunk(0), RATE, 0);
  session.setMicClockTrimPpm(200);
  let cursor = CHUNK;
  for (let nowMs = 20; nowMs < 2_000; nowMs += 20) {
    session.ingestMic(toneChunk(cursor), RATE, nowMs);
    cursor += CHUNK;
  }
  assert.ok(session.micClockTrimSamples > 0);

  session.ingestMic(toneChunk(0, 8), RATE, 2_000);
  assert.equal(session.micClockTrimPpm, 0);
  assert.equal(session.micClockTrimSamples, 0);

  session.setMicClockTrimPpm(200);
  session.retireMicCapture();
  assert.equal(session.micClockTrimPpm, 0);
});

test('a packet after a hole still owes trim for the hole, applied at the next contiguous packet', () => {
  const session = makeSession();
  session.ingestMic(toneChunk(0), RATE, 0);
  session.setMicClockTrimPpm(500);
  // 500 ppm of one second is 24 samples; lose most of that second.
  session.ingestMic(toneChunk(RATE), RATE, 1_000);
  assert.equal(session.micClockTrimSamples, 0, 'a packet after a hole is never trimmed itself');
  let cursor = RATE + CHUNK;
  for (let nowMs = 1_020; nowMs < 2_220; nowMs += 20) {
    session.ingestMic(toneChunk(cursor), RATE, nowMs);
    cursor += CHUNK;
  }
  // 24 owed across the hole plus about 29 over the 60 packets after it, paid
  // at most one sample per packet.
  assert.ok(session.micClockTrimSamples >= 50, `trimmed ${session.micClockTrimSamples}`);
  assert.ok(session.micClockTrimSamples <= 54, `trimmed ${session.micClockTrimSamples}`);
});
