import assert from 'node:assert/strict';
import test from 'node:test';

import type { MixFrameEvidence } from '../src/audio-session.js';
import {
  TAKE_QUALITY_POLICY_VERSION,
  TakeQualityTracker,
  assessTakeQuality,
  type TakeQualityEvidence,
  type TakeQualityFrameState,
} from '../src/take-quality.js';

const RATE = 48_000;

function mixedFrame(patch: Partial<MixFrameEvidence> = {}): MixFrameEvidence {
  return {
    micGapSamples: 0,
    backingGapSamples: 0,
    micStarvedSamples: 0,
    backingStarvedSamples: 0,
    micUnavailableSamples: 0,
    backingUnavailableSamples: 0,
    clippedSamples: 0,
    limitedSamples: 0,
    unheaderedSamples: 0,
    ...patch,
  };
}

function frameState(patch: Partial<TakeQualityFrameState> = {}): TakeQualityFrameState {
  return {
    timingMode: 'acoustic-calibration',
    calibrationStale: false,
    alignmentClamped: false,
    robotRoute: false,
    robotDeltaFresh: true,
    timingDivergenceMs: null,
    ...patch,
  };
}

function evidence(patch: Partial<TakeQualityEvidence> = {}): TakeQualityEvidence {
  return {
    sampleRate: RATE,
    recordedSamples: RATE,
    recordedDurationMs: 1_000,
    micGapSamples: 0,
    micGapMs: 0,
    backingGapSamples: 0,
    backingGapMs: 0,
    micStarvedFrames: 0,
    backingStarvedFrames: 0,
    micStarvedSamples: 0,
    backingStarvedSamples: 0,
    micStarvedMs: 0,
    backingStarvedMs: 0,
    clippedSamples: 0,
    clippedMs: 0,
    limitedSamples: 0,
    limitedMs: 0,
    unheaderedSamples: 0,
    unheadered: false,
    micUnavailableSamples: 0,
    micUnavailableMs: 0,
    backingUnavailableSamples: 0,
    backingUnavailableMs: 0,
    networkEstimateSamples: 0,
    networkEstimateMs: 0,
    calibrationStaleSamples: 0,
    calibrationStaleMs: 0,
    alignmentClampedSamples: 0,
    alignmentClampedMs: 0,
    robotDeltaMissingSamples: 0,
    robotDeltaMissingMs: 0,
    timingDivergedSamples: 0,
    timingDivergedMs: 0,
    peakTimingDivergenceMs: 0,
    timingDivergenceToleranceMs: 40,
    events: {
      'mic-transport-disconnected': 0,
      'mic-transport-connected': 0,
      'mic-capture-restarted': 0,
      'backing-transport-disconnected': 0,
      'backing-transport-connected': 0,
      'backing-transport-replaced': 0,
      'backing-capture-restarted': 0,
      'robot-source-disconnected': 0,
      'robot-source-connected': 0,
      'robot-source-replaced': 0,
      'mic-owner-changed': 0,
      'server-shutdown': 0,
    },
    ...patch,
  };
}

function tracker() {
  return new TakeQualityTracker({ sampleRate: RATE });
}

test('Take quality is driven by exact mixed-frame evidence, not epoch counters', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.verdict, 'clean');
  assert.equal(result.evidence.sampleRate, RATE);
  assert.equal(result.evidence.recordedDurationMs, 20);
  assert.equal(result.evidence.micGapSamples, 0);
  assert.equal(result.evidence.micGapMs, 0);
  assert.equal(result.evidence.backingGapSamples, 0);
  assert.equal(result.evidence.micStarvedFrames, 0);
  assert.equal(result.evidence.clippedSamples, 0);
  assert.equal(result.evidence.limitedSamples, 0);
  assert.equal(result.evidence.unheadered, false);
});

test('a gap already known by the mixer is charged when the recorded frame actually reads it', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame({ micGapSamples: 960 }));

  const result = quality.assessment();
  assert.equal(result.evidence.micGapSamples, 960);
  assert.equal(result.evidence.micGapMs, 20);
  assert.equal(result.verdict, 'review');
  assert.equal(result.issues.some((issue) => issue.code === 'mic-pcm-gap'), true);
});

test('future mixer gaps do not affect a frame whose exact evidence is complete', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.evidence.micGapSamples, 0);
  assert.equal(result.evidence.micGapMs, 0);
  assert.equal(result.verdict, 'clean');
});

test('Take quality accumulates timing duration from exact frames accepted by the recorder', () => {
  const quality = tracker();

  quality.observeFrame(960, frameState({
    timingMode: 'network-estimate',
    calibrationStale: true,
    alignmentClamped: true,
    robotRoute: true,
    robotDeltaFresh: false,
  }), mixedFrame({ micUnavailableSamples: 960 }));
  quality.observeFrame(960, frameState(), mixedFrame({ backingUnavailableSamples: 960 }));

  const result = quality.assessment();
  assert.equal(result.evidence.recordedSamples, 1_920);
  assert.equal(result.evidence.recordedDurationMs, 40);
  assert.equal(result.evidence.micUnavailableSamples, 960);
  assert.equal(result.evidence.micUnavailableMs, 20);
  assert.equal(result.evidence.backingUnavailableSamples, 960);
  assert.equal(result.evidence.backingUnavailableMs, 20);
  assert.equal(result.evidence.networkEstimateSamples, 960);
  assert.equal(result.evidence.networkEstimateMs, 20);
  assert.equal(result.evidence.calibrationStaleSamples, 960);
  assert.equal(result.evidence.calibrationStaleMs, 20);
  assert.equal(result.evidence.alignmentClampedSamples, 960);
  assert.equal(result.evidence.alignmentClampedMs, 20);
  assert.equal(result.evidence.robotDeltaMissingSamples, 960);
  assert.equal(result.evidence.robotDeltaMissingMs, 20);
  assert.equal(result.verdict, 'review');
});

test('a complete buffered frame carries no unavailable evidence regardless of transport context', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.evidence.micUnavailableSamples, 0);
  assert.equal(result.evidence.micUnavailableMs, 0);
  assert.equal(result.evidence.backingUnavailableSamples, 0);
  assert.equal(result.evidence.backingUnavailableMs, 0);
  assert.equal(result.verdict, 'clean');
});

test('partial starvation preserves sub-millisecond loss without inflating it to whole frames', () => {
  const quality = tracker();
  for (let i = 0; i < 13; i += 1) {
    quality.observeFrame(960, frameState(), mixedFrame({ micStarvedSamples: 1 }));
  }

  const result = quality.assessment();
  assert.equal(result.evidence.micStarvedFrames, 13);
  assert.equal(result.evidence.micStarvedSamples, 13);
  assert.equal(result.evidence.micStarvedMs, (13 / RATE) * 1000);
  assert.equal(result.issues.find((issue) => issue.code === 'mic-starvation')?.severity, 'warning');
  assert.equal(result.verdict, 'review');
});

test('microphone limiting is retained as evidence but is not itself a failed Take', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame({ limitedSamples: 960 }));

  const result = quality.assessment();
  assert.equal(result.evidence.limitedSamples, 960);
  assert.equal(result.evidence.limitedMs, 20);
  assert.equal(result.verdict, 'clean');
  assert.deepEqual(result.issues, []);
});

test('legacy unpositioned PCM is scoped to samples actually mixed into the Take', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame());
  assert.equal(quality.assessment().evidence.unheadered, false);

  quality.observeFrame(960, frameState(), mixedFrame({ unheaderedSamples: 480 }));
  const result = quality.assessment();
  assert.equal(result.evidence.unheaderedSamples, 480);
  assert.equal(result.evidence.unheadered, true);
  assert.equal(result.verdict, 'review');
  assert.equal(result.issues.some((issue) => issue.code === 'unheadered-pcm'), true);
});

test('transport changes are review evidence, not proof that audible recording was damaged', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame());
  quality.noteEvent('mic-transport-disconnected');
  quality.noteEvent('mic-transport-connected');
  quality.observeFrame(960, frameState(), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.verdict, 'review');
  assert.equal(result.evidence.events['mic-transport-disconnected'], 1);
  assert.equal(result.evidence.events['mic-transport-connected'], 1);
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === 'transport-instability').map((issue) => issue.severity),
    ['warning'],
  );
});

test('sustained missing audio and impossible timing correction make a Take degraded', () => {
  const result = assessTakeQuality(evidence({
    micUnavailableSamples: 12_480,
    micUnavailableMs: 260,
    alignmentClampedSamples: 14_400,
    alignmentClampedMs: 300,
  }));
  assert.equal(result.policyVersion, TAKE_QUALITY_POLICY_VERSION);
  assert.equal(result.verdict, 'degraded');
  assert.equal(
    result.issues.filter((issue) => issue.severity === 'critical').map((issue) => issue.code).sort().join(','),
    'alignment-clamped,mic-unavailable',
  );
});

test('small clipping asks for review while sustained clipping is degraded', () => {
  const small = assessTakeQuality(evidence({ clippedSamples: 240, clippedMs: 5 }));
  assert.equal(small.verdict, 'review');
  assert.equal(small.issues.find((issue) => issue.code === 'output-clipping')?.severity, 'warning');

  const sustained = assessTakeQuality(evidence({ clippedSamples: 960, clippedMs: 20 }));
  assert.equal(sustained.verdict, 'degraded');
  assert.equal(sustained.issues.find((issue) => issue.code === 'output-clipping')?.severity, 'critical');
});


test('controlled server shutdown is explicit review evidence', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame());
  quality.noteEvent('server-shutdown');

  const result = quality.assessment();
  assert.equal(result.evidence.events['server-shutdown'], 1);
  assert.equal(result.verdict, 'review');
  assert.equal(result.issues.some((issue) => issue.code === 'recording-interrupted'), true);
});

test('a Take that holds its alignment while the mapping moves under it is not clean', () => {
  const quality = tracker();
  // The mixer alignment is deliberately frozen for the whole recording, so the
  // mapping moving underneath leaves every other signal reading healthy.
  quality.observeFrame(960, frameState({ timingDivergenceMs: 450 }), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.evidence.timingDivergedSamples, 960);
  assert.equal(result.evidence.timingDivergedMs, 20);
  assert.equal(result.evidence.peakTimingDivergenceMs, 450);
  assert.equal(result.evidence.calibrationStaleMs, 0);
  assert.equal(result.evidence.robotDeltaMissingMs, 0);
  assert.equal(result.evidence.networkEstimateMs, 0);
  assert.notEqual(result.verdict, 'clean');
  assert.equal(result.issues.some((issue) => issue.code === 'timing-diverged'), true);
});

test('divergence below the mixer own re-apply threshold is player jitter, not drift', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState({ timingDivergenceMs: 39 }), mixedFrame());
  quality.observeFrame(960, frameState({ timingDivergenceMs: -39 }), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.evidence.timingDivergedSamples, 0);
  assert.equal(result.evidence.peakTimingDivergenceMs, 0);
  assert.equal(result.verdict, 'clean');
});

test('divergence is charged by magnitude in either direction', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState({ timingDivergenceMs: -820 }), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.evidence.timingDivergedSamples, 960);
  assert.equal(result.evidence.peakTimingDivergenceMs, 820);
});

test('an unknown desired alignment is not evidence of divergence', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState({ timingDivergenceMs: null }), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.evidence.timingDivergedSamples, 0);
  assert.equal(result.verdict, 'clean');
});

test('sustained divergence degrades the Take rather than only asking for review', () => {
  const result = assessTakeQuality(evidence({
    timingDivergedSamples: 14_400,
    timingDivergedMs: 300,
    peakTimingDivergenceMs: 512,
    timingDivergenceToleranceMs: 150,
  }));
  assert.equal(result.verdict, 'degraded');
  const issue = result.issues.find((candidate) => candidate.code === 'timing-diverged');
  assert.equal(issue?.severity, 'critical');
  // The message names both the drift and the line it crossed, so a stored
  // assessment can be read without knowing the deployment's configuration.
  assert.match(String(issue?.message), /512 ms/);
  assert.match(String(issue?.message), /150 ms/);
});

test('the tolerance is the mixer own re-apply threshold, not a number of our own', () => {
  // Deployments tune RELAY_CALIBRATION_DELTA_REAPPLY_MS; this Pi runs 150.
  // Below that line the mixer deliberately declines to chase the delta, so an
  // ordinary Take sits inside the band for its whole duration. Charging it
  // would fire on healthy recordings.
  const lenient = new TakeQualityTracker({ sampleRate: RATE, timingDivergenceToleranceMs: 150 });
  lenient.observeFrame(960, frameState({ timingDivergenceMs: 120 }), mixedFrame());

  const lenientResult = lenient.assessment();
  assert.equal(lenientResult.evidence.timingDivergedSamples, 0);
  assert.equal(lenientResult.verdict, 'clean');

  // The same recording under a mixer that would have corrected at 40 ms is a
  // correction the Take actually blocked.
  const strict = new TakeQualityTracker({ sampleRate: RATE, timingDivergenceToleranceMs: 40 });
  strict.observeFrame(960, frameState({ timingDivergenceMs: 120 }), mixedFrame());

  const strictResult = strict.assessment();
  assert.equal(strictResult.evidence.timingDivergedSamples, 960);
  assert.equal(strictResult.verdict, 'review');
});

test('a stored assessment records the tolerance it applied', () => {
  // The policy version says which rule ran; this says the one number that rule
  // was parameterised by, so an archived verdict stays readable.
  const quality = new TakeQualityTracker({ sampleRate: RATE, timingDivergenceToleranceMs: 150 });
  quality.observeFrame(960, frameState({ timingDivergenceMs: 400 }), mixedFrame());

  const result = quality.assessment();
  assert.equal(result.evidence.timingDivergenceToleranceMs, 150);
  assert.equal(result.evidence.timingDivergedSamples, 960);
});

test('an unconfigured or nonsense tolerance falls back to the documented default', () => {
  for (const timingDivergenceToleranceMs of [undefined, 0, -10, Number.NaN]) {
    const quality = new TakeQualityTracker({ sampleRate: RATE, timingDivergenceToleranceMs });
    quality.observeFrame(960, frameState({ timingDivergenceMs: 45 }), mixedFrame());

    const result = quality.assessment();
    assert.equal(result.evidence.timingDivergenceToleranceMs, 40, `tolerance ${timingDivergenceToleranceMs}`);
    assert.equal(result.evidence.timingDivergedSamples, 960);
  }
});
