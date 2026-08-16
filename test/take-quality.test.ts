import assert from 'node:assert/strict';
import test from 'node:test';

import type { MixHealth } from '../src/audio-session.js';
import {
  TAKE_QUALITY_POLICY_VERSION,
  TakeQualityTracker,
  assessTakeQuality,
  type TakeQualityEvidence,
  type TakeQualityFrameState,
} from '../src/take-quality.js';

function health(patch: Partial<MixHealth> = {}): MixHealth {
  return {
    micStarvedFrames: 0,
    backingStarvedFrames: 0,
    micHeadroomMs: 100,
    backingHeadroomMs: 100,
    micGapMs: 0,
    backingGapMs: 0,
    clippedSamples: 0,
    limitedSamples: 0,
    micPeakDbfs: -12,
    micRmsDbfs: -24,
    unheadered: false,
    ...patch,
  };
}

function frameState(patch: Partial<TakeQualityFrameState> = {}): TakeQualityFrameState {
  return {
    micAvailable: true,
    backingAvailable: true,
    timingMode: 'acoustic-calibration',
    calibrationStale: false,
    alignmentClamped: false,
    robotRoute: false,
    robotDeltaFresh: true,
    ...patch,
  };
}

function evidence(patch: Partial<TakeQualityEvidence> = {}): TakeQualityEvidence {
  return {
    recordedSamples: 48_000,
    recordedDurationMs: 1_000,
    micGapMs: 0,
    backingGapMs: 0,
    micStarvedFrames: 0,
    backingStarvedFrames: 0,
    micStarvedMs: 0,
    backingStarvedMs: 0,
    clippedSamples: 0,
    clippedMs: 0,
    limitedSamples: 0,
    limitedMs: 0,
    unheadered: false,
    micUnavailableMs: 0,
    backingUnavailableMs: 0,
    networkEstimateMs: 0,
    calibrationStaleMs: 0,
    alignmentClampedMs: 0,
    robotDeltaMissingMs: 0,
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
    },
    ...patch,
  };
}

test('Take quality baselines epoch counters instead of inheriting pre-Take failures', () => {
  const tracker = new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health({
      micGapMs: 180,
      backingGapMs: 60,
      micStarvedFrames: 9,
      backingStarvedFrames: 3,
      clippedSamples: 800,
      limitedSamples: 4_000,
      unheadered: true,
    }),
  });

  tracker.observeFrame(960, frameState(), health({
    micGapMs: 180,
    backingGapMs: 60,
    micStarvedFrames: 9,
    backingStarvedFrames: 3,
    clippedSamples: 800,
    limitedSamples: 4_000,
    unheadered: true,
  }));

  const result = tracker.assessment();
  assert.equal(result.verdict, 'clean');
  assert.equal(result.evidence.recordedDurationMs, 20);
  assert.equal(result.evidence.micGapMs, 0);
  assert.equal(result.evidence.backingGapMs, 0);
  assert.equal(result.evidence.micStarvedFrames, 0);
  assert.equal(result.evidence.clippedSamples, 0);
  assert.equal(result.evidence.limitedSamples, 0);
  assert.equal(result.evidence.unheadered, false);
});

test('Take quality accumulates duration from exact frames accepted by the recorder', () => {
  const tracker = new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health(),
  });

  tracker.observeFrame(960, frameState({
    micAvailable: false,
    timingMode: 'network-estimate',
    calibrationStale: true,
    alignmentClamped: true,
    robotRoute: true,
    robotDeltaFresh: false,
  }), health());
  tracker.observeFrame(960, frameState({ backingAvailable: false }), health());

  const result = tracker.assessment();
  assert.equal(result.evidence.recordedSamples, 1_920);
  assert.equal(result.evidence.recordedDurationMs, 40);
  assert.equal(result.evidence.micUnavailableMs, 20);
  assert.equal(result.evidence.backingUnavailableMs, 20);
  assert.equal(result.evidence.networkEstimateMs, 20);
  assert.equal(result.evidence.calibrationStaleMs, 20);
  assert.equal(result.evidence.alignmentClampedMs, 20);
  assert.equal(result.evidence.robotDeltaMissingMs, 20);
  assert.equal(result.verdict, 'review');
});

test('microphone limiting is retained as evidence but is not itself a failed Take', () => {
  const tracker = new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health({ limitedSamples: 2_000 }),
  });
  tracker.observeFrame(960, frameState(), health({ limitedSamples: 2_960 }));

  const result = tracker.assessment();
  assert.equal(result.evidence.limitedSamples, 960);
  assert.equal(result.evidence.limitedMs, 20);
  assert.equal(result.verdict, 'clean');
  assert.deepEqual(result.issues, []);
});

test('legacy unpositioned PCM is scoped to a new warning observed during the active Take', () => {
  const inherited = new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health({ unheadered: true }),
  });
  inherited.observeFrame(960, frameState(), health({ unheadered: true }));
  assert.equal(inherited.assessment().evidence.unheadered, false);

  const appearedDuringTake = new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health({ unheadered: false }),
  });
  appearedDuringTake.observeFrame(960, frameState(), health({ unheadered: false }));
  appearedDuringTake.observeFrame(960, frameState(), health({ unheadered: true }));
  const result = appearedDuringTake.assessment();
  assert.equal(result.evidence.unheadered, true);
  assert.equal(result.verdict, 'review');
  assert.equal(result.issues.some((issue) => issue.code === 'unheadered-pcm'), true);
});

test('transport changes are review evidence, not proof that audible recording was damaged', () => {
  const tracker = new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health(),
  });
  tracker.observeFrame(960, frameState(), health());
  tracker.noteEvent('mic-transport-disconnected');
  tracker.noteEvent('mic-transport-connected');
  tracker.observeFrame(960, frameState(), health());

  const result = tracker.assessment();
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
    micUnavailableMs: 260,
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
