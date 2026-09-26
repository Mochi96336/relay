import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';

const RATE = 48_000;
const CHUNK = 960;
const NETWORK_MS = 50;

function toneChunk(firstSampleIndex: number) {
  const pcm = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < CHUNK; i += 1) {
    const n = firstSampleIndex + i;
    pcm.writeInt16LE(Math.round(8_000 * Math.sin((2 * Math.PI * 220 * n) / RATE)), i * 2);
  }
  return { generation: 7, firstSampleIndex, pcm };
}

/**
 * A phone capture clock `ppm` slower than the mix clock, delivering 20 ms
 * chunks with a fixed network delay. Returns every emitted frame's applied
 * Mic advance and whether the frame starved.
 */
function runSlowCapture(ppm: number, seconds: number) {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.setMicExpected(true);
  session.setAlignment({ calibratedMicLagMs: 150 });

  const phoneRate = RATE * (1 - ppm * 1e-6);
  let sourceCursor = 0;
  const advances: number[] = [];
  const headrooms: number[] = [];
  let starvedFrames = 0;
  for (let nowMs = 0; nowMs <= seconds * 1_000; nowMs += 5) {
    while (((sourceCursor + CHUNK) / phoneRate) * 1_000 + NETWORK_MS <= nowMs) {
      const capturedEndMs = ((sourceCursor + CHUNK) / phoneRate) * 1_000;
      session.ingestMic(toneChunk(sourceCursor), RATE, capturedEndMs + NETWORK_MS);
      sourceCursor += CHUNK;
    }
    session.drain((_frame, evidence) => {
      if (evidence.micStarvedSamples > 0 || evidence.micGapSamples > 0) starvedFrames += 1;
      advances.push(session.appliedMicAdvanceMs);
      headrooms.push(session.liveMicHeadroomMs ?? 0);
    }, nowMs);
  }
  return { session, advances, headrooms, starvedFrames };
}

test('a frontier drained by a slow capture clock is not answered with a 200 ms read-head jump', () => {
  // 1000 ppm spends the ~217 ms of live headroom in under four minutes; a
  // real phone at 50 ppm takes about seventy.
  const { session, advances, headrooms, starvedFrames } = runSlowCapture(1_000, 300);

  let largestJumpMs = 0;
  for (let index = 1; index < advances.length; index += 1) {
    largestJumpMs = Math.max(largestJumpMs, Math.abs(advances[index] - advances[index - 1]));
  }
  assert.ok(
    session.micFrontierCorrectionMs > 150,
    `the drained frontier must still be corrected, saw ${session.micFrontierCorrectionMs} ms`,
  );
  // Only the overrun and one frame of cushion are stepped; the margin is slewed.
  assert.ok(largestJumpMs <= 45, `the read head jumped ${largestJumpMs.toFixed(1)} ms in one frame`);
  assert.equal(starvedFrames, 0, 'the gentler correction must not let the mix read past arrived audio');
  assert.ok(
    headrooms.at(-1)! > 100,
    `the slew must restore live headroom for late packets, ended at ${headrooms.at(-1)} ms`,
  );
});

test('a late stream that appears at once is still corrected in one step', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.setMicExpected(true);
  session.setAlignment({ calibratedMicLagMs: 150 });

  let cursor = 0;
  let nowMs = 0;
  for (; nowMs < 2_000; nowMs += 20) {
    session.ingestMic(toneChunk(cursor), RATE, nowMs);
    cursor += CHUNK;
    session.drain(() => {}, nowMs);
  }
  // Delivery becomes 300 ms later from here on, and stays that way.
  const lateByChunks = 15;
  const before = session.appliedMicAdvanceMs;
  const advances: number[] = [];
  for (; nowMs < 4_000; nowMs += 20) {
    if (nowMs >= 2_000 + lateByChunks * 20) {
      session.ingestMic(toneChunk(cursor), RATE, nowMs);
      cursor += CHUNK;
    }
    session.drain(() => advances.push(session.appliedMicAdvanceMs), nowMs);
  }
  const firstMove = advances.findIndex((advance) => advance !== before);
  assert.ok(firstMove >= 0, 'a late stream must be held back');
  assert.ok(
    before - advances[firstMove] > 100,
    `a large overrun keeps its single safety-margin step, moved ${before - advances[firstMove]} ms`,
  );
});

function maxAdjacentStep(frames: Buffer[]) {
  let previous: number | null = null;
  let largest = 0;
  for (const output of frames) {
    for (let index = 0; index < output.byteLength / 2; index += 1) {
      const current = output.readInt16LE(index * 2);
      if (previous !== null) largest = Math.max(largest, Math.abs(current - previous));
      previous = current;
    }
  }
  return largest;
}

// A 220 Hz tone at 8000 moves at most about 230 per sample on its own.
const TONE_SLOPE_LIMIT = 1_000;

function steadyToneSession() {
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
  let cursor = 0;
  let nowMs = 0;
  const frames: Buffer[] = [];
  for (; nowMs < 2_000; nowMs += 20) {
    session.ingestMic(toneChunk(cursor), RATE, nowMs);
    cursor += CHUNK;
    session.drain((output) => frames.push(output), nowMs);
  }
  return { session, cursor, nowMs, frames };
}

test('a capture restart that drops a held correction crossfades the read-head move', () => {
  const { session, cursor, nowMs } = steadyToneSession();
  // A held correction smaller than the live slack: dropping it moves the read
  // head forward inside the retiring capture's own, still retained, audio.
  (session as any).micFrontierCorrectionSamples = Math.round(RATE * 0.05);
  const frames: Buffer[] = [];
  session.drain((output) => frames.push(output), nowMs);
  session.drain((output) => frames.push(output), nowMs + 20);

  session.ingestMic({ ...toneChunk(cursor), generation: 8, firstSampleIndex: 0 }, RATE, nowMs + 20);
  for (let t = nowMs + 40; t <= nowMs + 120; t += 20) {
    session.drain((output) => frames.push(output), t);
  }
  const step = maxAdjacentStep(frames);
  assert.ok(step < TONE_SLOPE_LIMIT, `dropping the correction spliced the voice by ${step}`);
});

test('a read-head jump whose crossfade would read across a hole still does not splice', () => {
  const { session, cursor, nowMs } = steadyToneSession();
  // Chunk k sits at session sample 960 k, and frame f reads the Mic from
  // 960 f + 150 ms (7.5 chunks). Lose chunk h; at frame h - 7 the old read
  // leg starts halfway into that hole, so a crossfade there would read it.
  const firstChunk = cursor / CHUNK;
  const lost = firstChunk + 2;
  const jumpFrame = lost - 7;
  const jumpAtMs = 400 + jumpFrame * 20;
  const frames: Buffer[] = [];
  let chunk = firstChunk;
  for (let t = nowMs; t < jumpAtMs + 300; t += 20) {
    if (chunk !== lost) session.ingestMic(toneChunk(chunk * CHUNK), RATE, t);
    chunk += 1;
    // An immediate authority change well past the bounded slew rate.
    if (t === jumpAtMs) session.setAlignment({ calibratedMicLagMs: 90 });
    session.drain((output) => frames.push(output), t);
  }
  assert.ok(session.micConcealedSampleCount > 0, 'fixture must lose one positioned packet');
  const step = maxAdjacentStep(frames);
  assert.ok(step < TONE_SLOPE_LIMIT, `the uncrossfadeable jump spliced the voice by ${step}`);
});
