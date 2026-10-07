import assert from 'node:assert/strict';
import test from 'node:test';
import { readMicSlewedRange, crossfadeMicReadHeadJump } from '../src/mic-frame-reader.js';
import { CaptureRestartBoundaries } from '../src/capture-restart-boundaries.js';
import { emptyPcmTimeline, type PcmChunk, type PcmEvidence, type PcmTimeline } from '../src/pcm-timeline.js';

type SlewResult = { samples: Int16Array; evidence: PcmEvidence; missingMask: Uint8Array;
  inputClippingMask: Uint8Array | null; firstPosition: number; rate: number };
type Fixture = { timeline: PcmTimeline; frameSamples?: number; start?: number;
  from?: number; to?: number; lookahead?: number; seams?: number[]; clipped?: number[] };

function timeline(...chunks: Array<Partial<PcmChunk> & { start: number; samples: Int16Array }>) {
  const result = emptyPcmTimeline();
  result.chunks = chunks.map((chunk) => ({ positioned: true, ...chunk }));
  result.totalSamples = Math.max(0, ...chunks.map((chunk) => chunk.start + chunk.samples.length));
  return result;
}
const chunk = (start: number, ...samples: number[]) => ({ start, samples: Int16Array.from(samples) });

// These exact numerical fixtures passed on the original AudioSession reader
// before this adapter switched to the extracted helper (see C0 log).
function read(input: Fixture): SlewResult {
  const frameSamples = input.frameSamples ?? 1;
  const seams = new CaptureRestartBoundaries();
  for (const seam of input.seams ?? []) seams.queue(seam);
  return readMicSlewedRange({ timeline: input.timeline, frameSamples,
    startSample: input.start ?? 0, fromAdvanceSamples: input.from ?? 0.5,
    toAdvanceSamples: input.to ?? input.from ?? 0.5, lookaheadSamples: input.lookahead ?? 0,
    inputClipping: { empty: !input.clipped?.length,
      at: (position) => input.clipped?.includes(position) ?? false },
    captureRestartBoundaries: seams });
}

test('half-position interpolation reads 1000/3000 as 2000, but a seam holds 1000', () => {
  const source = timeline(chunk(0, 1000, 3000));
  assert.equal(read({ timeline: source }).samples[0], 2000);
  assert.equal(read({ timeline: source, seams: [1] }).samples[0], 1000);
});

test('right-only legacy provenance is consumed only when the right PCM endpoint is consumed', () => {
  const source = timeline(chunk(0, 1000), { ...chunk(1, 3000), positioned: false });
  const ordinary = read({ timeline: source });
  assert.equal(ordinary.samples[0], 2000);
  assert.equal(ordinary.evidence.unheaderedSamples, 1);
  const bounded = read({ timeline: source, seams: [1] });
  assert.equal(bounded.samples[0], 1000);
  assert.equal(bounded.evidence.unheaderedSamples, 0);
});

test('right-only clipping follows the same seam query as audio and provenance', () => {
  const source = timeline(chunk(0, 1000, 3000));
  assert.deepEqual([...read({ timeline: source, clipped: [1] }).inputClippingMask!], [1]);
  const bounded = read({ timeline: source, clipped: [1], seams: [1] });
  assert.equal(bounded.samples[0], 1000);
  assert.deepEqual([...bounded.inputClippingMask!], [0]);
  assert.equal(read({ timeline: source }).inputClippingMask, null);
});

test('a raw right-endpoint hole affects PCM, gap evidence and missing mask together', () => {
  const source = timeline(chunk(0, 1000), chunk(2, 5000));
  const ordinary = read({ timeline: source });
  assert.equal(ordinary.samples[0], 500);
  assert.deepEqual(ordinary.evidence, { gapSamples: 1, frontierMissingSamples: 0, unheaderedSamples: 0 });
  assert.deepEqual([...ordinary.missingMask], [1]);
  const bounded = read({ timeline: source, seams: [1] });
  assert.equal(bounded.samples[0], 1000);
  assert.equal(bounded.evidence.gapSamples, 0);
  assert.deepEqual([...bounded.missingMask], [0]);
});

test('concealed right PCM is audible gap evidence, not a missing-source mask', () => {
  const source = timeline(chunk(0, 1000), { ...chunk(1, 3000), concealed: true });
  const result = read({ timeline: source });
  assert.equal(result.samples[0], 2000);
  assert.equal(result.evidence.gapSamples, 1);
  assert.deepEqual([...result.missingMask], [0]);
  const bounded = read({ timeline: source, seams: [1] });
  assert.equal(bounded.samples[0], 1000);
  assert.equal(bounded.evidence.gapSamples, 0);
});

test('frontier miss stays distinct from gap, and a seam excludes the missing endpoint', () => {
  const source = timeline(chunk(0, 1000));
  const result = read({ timeline: source });
  assert.equal(result.samples[0], 500);
  assert.deepEqual(result.evidence, { gapSamples: 0, frontierMissingSamples: 1, unheaderedSamples: 0 });
  assert.deepEqual([...result.missingMask], [1]);
  const bounded = read({ timeline: source, seams: [1] });
  assert.equal(bounded.samples[0], 1000);
  assert.equal(bounded.evidence.frontierMissingSamples, 0);
});

test('integer endpoints do not consume the right legacy/clipped sample', () => {
  const source = timeline(chunk(0, 1000), { ...chunk(1, 3000), positioned: false });
  const result = read({ timeline: source, from: 0, to: 0, clipped: [1] });
  assert.equal(result.samples[0], 1000);
  assert.equal(result.evidence.unheaderedSamples, 0);
  assert.deepEqual([...result.inputClippingMask!], [0]);
});

test('slew samples follow fractional rate but limiter lookahead resumes unity rate', () => {
  const source = timeline(chunk(0, 1000, 3000, 5000),
    { ...chunk(3, 7000, 9000), positioned: false });
  const result = read({ timeline: source, frameSamples: 2, from: 0, to: 1,
    lookahead: 2, clipped: [3, 4] });
  assert.deepEqual([...result.samples], [1000, 4000, 7000, 9000]);
  assert.equal(result.firstPosition, 0);
  assert.equal(result.rate, 1.5);
  assert.equal(result.evidence.unheaderedSamples, 0, 'lookahead is not emitted-frame evidence');
  assert.deepEqual([...result.inputClippingMask!], [0, 0]);
  assert.equal(result.missingMask.length, 2);
});

test('a hole in lookahead does not become emitted gap evidence', () => {
  const source = timeline(chunk(0, 1000, 3000, 5000), chunk(4, 9000));
  const result = read({ timeline: source, frameSamples: 2, from: 0, to: 1, lookahead: 2 });
  assert.deepEqual([...result.samples], [1000, 4000, 0, 9000]);
  assert.equal(result.evidence.gapSamples, 0);
});

test('negative structural pre-roll is silence but not a source failure', () => {
  const result = read({ timeline: timeline(chunk(0, 1000, 3000)), from: -1, to: -1 });
  assert.equal(result.samples[0], 0);
  assert.deepEqual(result.evidence, { gapSamples: 0, frontierMissingSamples: 0, unheaderedSamples: 0 });
  assert.deepEqual([...result.missingMask], [0]);
});

test('a negative slew preserves its fractional start and exact landing', () => {
  const result = read({ timeline: timeline(chunk(0, 1000, 3000, 5000, 7000)),
    frameSamples: 2, from: 1, to: 0, lookahead: 1 });
  assert.equal(result.firstPosition, 1);
  assert.equal(result.rate, 0.5);
  assert.deepEqual([...result.samples], [3000, 4000, 5000]);
});

test('reader owns returned PCM and does not mutate retained input', () => {
  const source = timeline(chunk(0, 1000, 3000));
  const before = source.chunks[0]!.samples.slice();
  const result = read({ timeline: source });
  result.samples[0] = 9999;
  assert.deepEqual(source.chunks[0]!.samples, before);
});

type CrossfadeFixture = Fixture & { current: Int16Array<ArrayBuffer>; toStart?: number;
  previous?: number | null; forwardCalls?: Array<[number, number]> };
function crossfade(input: CrossfadeFixture) {
  const frameSamples = input.frameSamples ?? 5;
  const seams = new CaptureRestartBoundaries();
  for (const seam of input.seams ?? []) seams.queue(seam);
  return crossfadeMicReadHeadJump({ timeline: input.timeline, frameSamples,
    sampleRate: 1000, readHeadCrossfadeMs: 5,
    startSample: input.start ?? 0, fromAdvanceSamples: input.from ?? 0,
    toStartSample: input.toStart ?? 10, current: input.current,
    previousSourceSample: input.previous === undefined ? -1 : input.previous,
    inputClipping: { at: (position) => input.clipped?.includes(position) ?? false },
    captureRestartBoundaries: { firstForwardCrossing: (from, to) => {
      input.forwardCalls?.push([from, to]); return seams.firstForwardCrossing(from, to);
    } } });
}
function crossfadeSource() {
  return timeline(chunk(0, 1000, 2000, 3000, 4000, 5000, 6000),
    chunk(10, 9000, 9000, 9000, 9000, 9000));
}

test('crossfade changes current PCM in place, leaves its tail and retained chunks untouched', () => {
  const source = crossfadeSource();
  const before = source.chunks.map((c) => c.samples.slice());
  const current = Int16Array.from([9000, 9000, 9000, 9000, 9000, 777, 888]);
  const result = crossfade({ timeline: source, current });
  assert.equal(result.samples, current);
  assert.deepEqual([...current], [1000, 3750, 6000, 7750, 9000, 777, 888]);
  assert.deepEqual(source.chunks.map((c) => c.samples), before);
});

test('old crossfade leg holds seam-minus-one PCM instead of entering replacement capture', () => {
  const result = crossfade({ timeline: crossfadeSource(), seams: [3],
    current: new Int16Array(5).fill(9000) });
  assert.deepEqual([...result.samples], [1000, 3750, 6000, 7500, 9000]);
});

test('fractional old-leg endpoint blocks right-only clipping and legacy evidence at a seam', () => {
  const source = timeline(chunk(0, 1000), { ...chunk(1, 3000), positioned: false },
    chunk(2, 5000, 7000, 9000, 11000), chunk(10, 9000, 9000, 9000, 9000, 9000));
  const input = { timeline: source, from: 0.5, clipped: [1] };
  const ordinary = crossfade({ ...input, current: new Int16Array(5).fill(9000) });
  assert.equal(ordinary.samples[0], 2000);
  assert.equal(ordinary.unheaderedSamplesDelta, 2);
  assert.equal(ordinary.inputClippedSamplesDelta, 2);
  const bounded = crossfade({ ...input, seams: [1], current: new Int16Array(5).fill(9000) });
  assert.deepEqual([...bounded.samples], [1000, 3000, 5000, 7000, 9000]);
  assert.equal(bounded.unheaderedSamplesDelta, 0);
  assert.equal(bounded.inputClippedSamplesDelta, 0);
});

test('new-leg-only evidence is not attributed where its output weight is zero', () => {
  const source = crossfadeSource();
  source.chunks[1]!.positioned = false;
  const result = crossfade({ timeline: source, clipped: [10, 11, 12, 13, 14],
    current: new Int16Array(5).fill(9000) });
  assert.equal(result.unheaderedSamplesDelta, -1);
  assert.equal(result.inputClippedSamplesDelta, -1);
});

test('old-leg-only evidence contributes exactly while its output weight is positive', () => {
  const source = crossfadeSource();
  source.chunks[0]!.positioned = false;
  const result = crossfade({ timeline: source, clipped: [0, 1, 2, 3, 4, 5],
    current: new Int16Array(5).fill(9000) });
  assert.equal(result.unheaderedSamplesDelta, 4);
  assert.equal(result.inputClippedSamplesDelta, 4);
});

test('held old seam evidence is retained without accepting replacement-only provenance', () => {
  const source = timeline({ ...chunk(0, 1000, 2000, 3000), positioned: false },
    chunk(3, 31000, 31000, 31000), chunk(10, 9000, 9000, 9000, 9000, 9000));
  const result = crossfade({ timeline: source, seams: [3], clipped: [2],
    current: new Int16Array(5).fill(9000) });
  assert.equal(result.unheaderedSamplesDelta, 4);
  assert.equal(result.inputClippedSamplesDelta, 2);
  assert.deepEqual([...result.samples], [1000, 3750, 6000, 7500, 9000]);
});

test('old-leg query stays forward-only even when its end is behind the previous source position', () => {
  const calls: Array<[number, number]> = [];
  const result = crossfade({ timeline: crossfadeSource(), seams: [80, 100], previous: 100,
    forwardCalls: calls, current: new Int16Array(5).fill(9000) });
  assert.deepEqual(calls, [[100, 6]]);
  assert.deepEqual([...result.samples], [1000, 3750, 6000, 7750, 9000]);
});

test('no previous source position does not consult retained seams', () => {
  const calls: Array<[number, number]> = [];
  crossfade({ timeline: crossfadeSource(), previous: null, seams: [3],
    forwardCalls: calls, current: new Int16Array(5).fill(9000) });
  assert.deepEqual(calls, []);
});

test('one-sample crossfade is entirely new PCM and does not charge old evidence', () => {
  const source = crossfadeSource();
  source.chunks[0]!.positioned = false;
  const result = crossfade({ timeline: source, frameSamples: 1, clipped: [0],
    current: Int16Array.from([9000]) });
  assert.deepEqual([...result.samples], [9000]);
  assert.equal(result.unheaderedSamplesDelta, 0);
  assert.equal(result.inputClippedSamplesDelta, 0);
});
