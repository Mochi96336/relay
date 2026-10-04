import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compressPcmSpanByOne,
  emptyPcmTimeline,
  readPcmEvidence,
  readPcmGapMask,
  readPcmRange,
  readPcmSourceEvidence,
  resamplePcm,
  retainsPcmAfter,
  SOURCE_CONCEALED,
  SOURCE_GAP,
  SOURCE_PAST_FRONTIER,
  SOURCE_UNHEADERED,
  stretchPcmSpanByOne,
  trimPcmTimeline,
  type PcmChunk,
} from '../src/pcm-timeline.js';

function timeline(chunks: PcmChunk[]) {
  const value = emptyPcmTimeline();
  value.chunks = chunks;
  const last = chunks.at(-1);
  value.totalSamples = last ? last.start + last.samples.length : 0;
  return value;
}

function ramp(start: number, count: number, step = 1) {
  return Int16Array.from({ length: count }, (_, index) => (start + index) * step);
}

/** 10..13, a 2-sample hole, then 16..17 unheadered and 18..19 concealed. */
const holed = timeline([
  { start: 10, samples: Int16Array.of(1, 2, 3, 4), positioned: true },
  { start: 16, samples: Int16Array.of(7, 8), positioned: false },
  { start: 18, samples: Int16Array.of(9, 9), positioned: true, concealed: true },
]);

test('reading a range returns what arrived, with silence for holes, pre-roll and the future', () => {
  assert.deepEqual([...readPcmRange(holed, 8, 14)], [0, 0, 1, 2, 3, 4, 0, 0, 7, 8, 9, 9, 0, 0]);
  assert.deepEqual([...readPcmRange(holed, -3, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...readPcmRange(emptyPcmTimeline(), 0, 3)], [0, 0, 0]);
});

test('evidence tells a hole from the frontier and keeps pre-roll out of both', () => {
  // 8..9 lie before the first chunk: inside the timeline's reach, so a gap.
  assert.deepEqual(readPcmEvidence(holed, 8, 14), {
    gapSamples: 2 + 2 + 2, // before the first chunk, the hole, the concealment
    frontierMissingSamples: 2,
    unheaderedSamples: 2,
  });
  assert.deepEqual(readPcmEvidence(holed, -5, 5), {
    gapSamples: 0,
    frontierMissingSamples: 0,
    unheaderedSamples: 0,
  });
  assert.deepEqual(readPcmEvidence(emptyPcmTimeline(), 0, 4), {
    gapSamples: 0,
    frontierMissingSamples: 4,
    unheaderedSamples: 0,
  });
});

test('per-sample evidence sets one bit per fact', () => {
  assert.deepEqual([...readPcmSourceEvidence(holed, 12, 10)], [
    0, 0,
    SOURCE_GAP, SOURCE_GAP,
    SOURCE_UNHEADERED, SOURCE_UNHEADERED,
    SOURCE_CONCEALED, SOURCE_CONCEALED,
    SOURCE_PAST_FRONTIER, SOURCE_PAST_FRONTIER,
  ]);
});

test('a gap mask marks only holes inside the timeline, never the frontier', () => {
  assert.deepEqual([...readPcmGapMask(holed, 12, 10)], [0, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
});

test('per-sample readers leave pre-roll unmarked and mark an empty timeline as frontier', () => {
  assert.deepEqual([...readPcmSourceEvidence(holed, -2, 3)], [0, 0, SOURCE_GAP]);
  assert.deepEqual([...readPcmGapMask(holed, -2, 3)], [0, 0, 1]);
  assert.deepEqual([...readPcmSourceEvidence(emptyPcmTimeline(), -1, 3)], [0, SOURCE_PAST_FRONTIER, SOURCE_PAST_FRONTIER]);
});

test('trimming drops whole chunks behind the line but always keeps the newest', () => {
  const trimmed = timeline([
    { start: 0, samples: ramp(0, 4), positioned: true },
    { start: 4, samples: ramp(4, 4), positioned: true },
    { start: 8, samples: ramp(8, 4), positioned: true },
  ]);
  trimPcmTimeline(trimmed, 5);
  assert.deepEqual(trimmed.chunks.map((chunk) => chunk.start), [4, 8]);
  trimPcmTimeline(trimmed, 1_000);
  assert.deepEqual(trimmed.chunks.map((chunk) => chunk.start), [8]);
  assert.equal(retainsPcmAfter(trimmed, 11), true);
  assert.equal(retainsPcmAfter(trimmed, 12), false);
});

test('a one-sample stretch or compression keeps both ends of the span', () => {
  const span = Int16Array.of(0, 100, 200, 300, 400);
  const stretched = stretchPcmSpanByOne(span);
  const compressed = compressPcmSpanByOne(span);
  assert.equal(stretched.length, 6);
  assert.equal(compressed.length, 4);
  assert.deepEqual([stretched[0], stretched.at(-1)], [0, 400]);
  assert.deepEqual([compressed[0], compressed.at(-1)], [0, 400]);
});

function pcmBuffer(values: Int16Array) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
}

test('consecutive resampled packets join exactly as if they were one', () => {
  const sourceRate = 44_100;
  const source = Int16Array.from(
    { length: 882 },
    (_, index) => Math.round(8_000 * Math.sin((2 * Math.PI * 440 * index) / sourceRate)),
  );
  const whole = resamplePcm(pcmBuffer(source), sourceRate, 48_000, 0);

  const first = resamplePcm(pcmBuffer(source.subarray(0, 441)), sourceRate, 48_000, 0);
  const second = resamplePcm(
    pcmBuffer(source.subarray(441)),
    sourceRate,
    48_000,
    441,
    [...source.subarray(441 - 3, 441)],
    first.nextTargetSample,
  );
  assert.deepEqual(
    [...first.samples, ...second.samples],
    [...whole.samples],
  );
  assert.equal(second.targetStart, (first.targetStart ?? 0) + first.samples.length);
});

test('PCM at the mix rate passes through untouched', () => {
  const source = Int16Array.of(5, -6, 7, -8);
  const result = resamplePcm(pcmBuffer(source), 48_000, 48_000, 960);
  assert.deepEqual([...result.samples], [...source]);
  assert.equal(result.targetStart, 960);
  assert.equal(result.nextTargetSample, 964);
});
