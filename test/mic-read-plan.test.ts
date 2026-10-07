import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioSession } from '../src/audio-session.js';
import { classifyMicReadMotion, type MicReadMotionInput } from '../src/mic-read-plan.js';

function classify(patch: Partial<MicReadMotionInput> = {}) {
  return classifyMicReadMotion({ frameSamples: 20, sampleRate: 1000, startSample: 40,
    previouslyEmittedAdvanceSamples: 0, previousAdvanceSamplesExact: 0,
    lastEmittedMicFrameComplete: true, appliedAdvanceMs: 0,
    runtimeCalibrationSlewFraction: 0.01, readHeadCrossfadeMs: 5, ...patch });
}

test('no emitted history cannot claim an immediate or convergence jump', () => {
  const result = classify({ previouslyEmittedAdvanceSamples: null,
    previousAdvanceSamplesExact: 40, appliedAdvanceMs: 40 });
  assert.equal(result.advanceSamplesExact, 40);
  assert.equal(result.advanceSamples, 40);
  assert.equal(result.micReadStart, 80);
  assert.equal(result.boundedRuntimeAdvanceMoved, false);
  assert.equal(result.immediateReadHeadJump, false);
  assert.equal(result.readHeadJumped, false);
  assert.equal(result.previousTransitionStart, 0);
});

for (const [name, previous, applied, bounded] of [
  ['zero', 0, 0, false],
  ['below epsilon', -0.9999e-9, 0, false],
  ['exact epsilon', -1e-9, 0, false],
  ['above epsilon', -1.0001e-9, 0, true],
  ['nominal epsilon rounded above by multiply/divide', 0, 1e-9, true],
  ['positive exact bound', 0, 1.4, true],
  ['negative exact bound', 0, -1.4, true],
  ['positive above bound', 0, 1.40001, false],
  ['negative above bound', 0, -1.40001, false],
] as const) {
  test(`bounded motion: ${name}`, () => {
    const result = classify({ previousAdvanceSamplesExact: previous, appliedAdvanceMs: applied });
    assert.equal(result.maximumBoundedRuntimeDeltaSamples, 1.4);
    assert.equal(result.boundedRuntimeAdvanceMoved, bounded);
  });
}

for (const [applied, rounded] of [[0.4999, 0], [0.5, 1], [0.5001, 1],
  [-0.4999, -0], [-0.5, -0], [-0.5001, -1]] as const) {
  test(`rounding preserves signed half-sample boundary ${applied}`, () => {
    const result = classify({ appliedAdvanceMs: applied });
    assert.ok(Object.is(result.advanceSamples, rounded));
    assert.equal(result.micReadStart, 40 + rounded);
  });
}

for (const complete of [true, false]) {
  test(`jump with previous complete=${complete} keeps convergence separate from crossfade eligibility`, () => {
    const result = classify({ appliedAdvanceMs: 40, lastEmittedMicFrameComplete: complete });
    assert.equal(result.readHeadJumped, true);
    assert.equal(result.immediateReadHeadJump, complete);
    assert.equal(result.boundedRuntimeAdvanceMoved, false);
  });
}

test('jump classification uses rounded new advance but actual fractional emitted history', () => {
  const result = classify({ appliedAdvanceMs: 1.4, previouslyEmittedAdvanceSamples: -0.5 });
  assert.equal(result.advanceSamples, 1);
  assert.equal(result.readHeadJumped, true); // 1 - (-0.5) exceeds 1.4.
  assert.equal(result.immediateReadHeadJump, true);
});

test('a fine-tune replacement cannot reconstruct the prior emitted trajectory', () => {
  const result = classify({ appliedAdvanceMs: -20, previouslyEmittedAdvanceSamples: 12.5,
    previousAdvanceSamplesExact: 12.5 });
  assert.equal(result.readHeadJumped, true);
  assert.equal(result.previousTransitionStart, 52);
  assert.equal(result.micReadStart, 20);
});

test('rebased history stays in the caller-supplied shifted coordinate', () => {
  const result = classify({ previouslyEmittedAdvanceSamples: 112.5,
    previousAdvanceSamplesExact: 112.5, appliedAdvanceMs: 112.5 });
  assert.equal(result.boundedRuntimeAdvanceMoved, false);
  assert.equal(result.readHeadJumped, false);
  assert.equal(result.previousTransitionStart, 152);
});

test('48 kHz constants preserve exact conversion, combined bound and crossfade length', () => {
  const result = classify({ frameSamples: 960, sampleRate: 48000,
    appliedAdvanceMs: 100.2, previousAdvanceSamplesExact: 4800,
    previouslyEmittedAdvanceSamples: 4800 });
  assert.equal(result.advanceSamplesExact, 4809.6);
  assert.equal(result.advanceSamples, 4810);
  assert.equal(result.maximumBoundedRuntimeDeltaSamples, 20.2);
  assert.equal(result.crossfadeSamples, 240);
  assert.equal(result.boundedRuntimeAdvanceMoved, true);
});

test('crossfade is bounded by frame size while preserving its two-sample floor', () => {
  assert.equal(classify({ frameSamples: 1 }).crossfadeSamples, 1);
  assert.equal(classify({ readHeadCrossfadeMs: 0 }).crossfadeSamples, 2);
});

test('classification neither changes nor retains a mutable input snapshot', () => {
  const input: MicReadMotionInput = Object.freeze({ frameSamples: 20, sampleRate: 1000,
    startSample: 40, previouslyEmittedAdvanceSamples: 0, previousAdvanceSamplesExact: 0,
    lastEmittedMicFrameComplete: true, appliedAdvanceMs: 0,
    runtimeCalibrationSlewFraction: 0.01, readHeadCrossfadeMs: 5 });
  assert.deepEqual(classifyMicReadMotion(input), classifyMicReadMotion(input));
});

for (const [name, length, gap, advance, complete, crossfade] of [
  ['both legs real', 100, null, 40, true, true],
  ['old leg gap', 100, 42, 40, true, false],
  ['new leg gap', 100, 82, 40, true, false],
  ['old leg frontier miss', 44, null, -40, true, false],
  ['new leg frontier miss', 83, null, 40, true, false],
  ['previous frame incomplete', 100, null, 40, false, false],
] as const) {
  test(`session evidence gate: ${name}`, () => {
    const session = new AudioSession({ sampleRate: 1000, frameMs: 20, prebufferMs: 400,
      backingGain: 0.65, retentionMs: 3000, backingRetentionMs: 6000 });
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: advance });
    const pcm = Buffer.alloc(length * 2);
    for (let index = 0; index < length; index += 1) pcm.writeInt16LE(1000, index * 2);
    if (gap === null) session.ingestMic({ generation: 1, firstSampleIndex: 0, pcm }, 1000, 0);
    else {
      session.ingestMic({ generation: 1, firstSampleIndex: 0, pcm: pcm.subarray(0, gap * 2) }, 1000, 0);
      session.ingestMic({ generation: 1, firstSampleIndex: gap + 1,
        pcm: pcm.subarray((gap + 1) * 2) }, 1000, 0);
    }
    // Test-only established history; no production snapshot/getMutableState.
    const state = session as unknown as {
      lastEmittedMicAdvanceSamples: number | null;
      lastEmittedMicFrameComplete: boolean;
      micEdge: { readonly replacementActive: boolean };
      planMicRead(index: number): { canCrossfadeReadHeadJump: boolean };
    };
    state.lastEmittedMicAdvanceSamples = 0;
    state.lastEmittedMicFrameComplete = complete;
    assert.equal(state.micEdge.replacementActive, false);
    assert.equal(state.planMicRead(2).canCrossfadeReadHeadJump, crossfade);
    assert.equal(state.micEdge.replacementActive, !crossfade,
      'a disallowed crossfade must converge, not replay old PCM over missing evidence');
    session.stop();
  });
}
