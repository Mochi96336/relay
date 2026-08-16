import assert from 'node:assert/strict';
import test from 'node:test';

import type { MixFrameEvidence, MixHealth } from '../src/audio-session.js';
import {
  TAKE_QUALITY_POLICY_VERSION,
  TakeQualityTracker,
  assessTakeQuality,
  type TakeQualityEvidence,
  type TakeQualityFrameState,
} from '../src/take-quality.js';

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
    lastMixedFrame: mixedFrame(),
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

function tracker() {
  return new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health({ lastMixedFrame: null }),
  });
}

test('Take quality ignores epoch counters and follows exact mixed-frame evidence', () => {
  const quality = new TakeQualityTracker({
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
      lastMixedFrame: null,
    }),
  });

  quality.observeFrame(960, frameState(), health({
    micGapMs: 180,
    backingGapMs: 60,
    micStarvedFrames: 9,
    backingStarvedFrames: 3,
    clippedSamples: 800,
    limitedSamples: 4_000,
    unheadered: true,
    lastMixedFrame: mixedFrame(),
  }));

  const result = quality.assessment();
  assert.equal(result.verdict, 'clean');
  assert.equal(result.evidence.recordedDurationMs, 20);
  assert.equal(result.evidence.micGapMs, 0);
  assert.equal(result.evidence.backingGapMs, 0);
  assert.equal(result.evidence.micStarvedFrames, 0);
  assert.equal(result.evidence.clippedSamples, 0);
  assert.equal(result.evidence.limitedSamples, 0);
  assert.equal(result.evidence.unheadered, false);
});

test('a gap detected before Start is still charged when the recorded frame actually reads it', () => {
  const quality = new TakeQualityTracker({
    sampleRate: 48_000,
    frameMs: 20,
    baselineHealth: health({ micGapMs: 20, lastMixedFrame: null }),
  });
  quality.observeFrame(960, frameState(), health({
    micGapMs: 20,
    lastMixedFrame: mixedFrame({ micGapSamples: 960 }),
  }));

  const result = quality.assessment();
  assert.equal(result.evidence.micGapMs, 20);
  assert.equal(result.verdict, 'review');
  assert.equal(result.issues.some((issue) => issue.code === 'mic-pcm-gap'), true);
});

test('a future gap detected before Stop is not charged until a recorded frame reaches it', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), health({
    micGapMs: 500,
    lastMixedFrame: mixedFrame(),
  }));

  const result = quality.assessment();
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
  }), health({
    lastMixedFrame: mixedFrame({ micUnavailableSamples: 960 }),
  }));
  quality.observeFrame(960, frameState(), health({
    lastMixedFrame: mixedFrame({ backingUnavailableSamples: 960 }),
  }));

  const result = quality.assessment();
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

test('transport liveness does not claim missing audio while the exact mixed frame is still buffered', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState({ micAvailable: false, backingAvailable: false }), health({
    lastMixedFrame: mixedFrame(),
  }));

  const result = quality.assessment();
  assert.equal(result.evidence.micUnavailableMs, 0);
  assert.equal(result.evidence.backingUnavailableMs, 0);
  assert.equal(result.verdict, 'clean');
});

test('partial starvation is measured by missing samples rather than whole output frames', () => {
  const quality = tracker();
  for (let i = 0; i < 13; i += 1) {
    quality.observeFrame(960, frameState(), health({
      lastMixedFrame: mixedFrame({ micStarvedSamples: 1 }),
    }));
  }

  const result = quality.assessment();
  assert.equal(result.evidence.micStarvedFrames, 13);
  assert.equal(result.evidence.micStarvedMs, 0);
  assert.equal(result.issues.some((issue) => issue.code === 'mic-starvation'), false);
  assert.equal(result.verdict, 'clean');
});

test('microphone limiting is retained as evidence but is not itself a failed Take', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), health({
    limitedSamples: 100_000,
    lastMixedFrame: mixedFrame({ limitedSamples: 960 }),
  }));

  const result = quality.assessment();
  assert.equal(result.evidence.limitedSamples, 960);
  assert.equal(result.evidence.limitedMs, 20);
  assert.equal(result.verdict, 'clean');
  assert.deepEqual(result.issues, []);
});

test('legacy unpositioned PCM is scoped to samples actually mixed into the Take', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), health({
    unheadered: true,
    lastMixedFrame: mixedFrame(),
  }));
  assert.equal(quality.assessment().evidence.unheadered, false);

  quality.observeFrame(960, frameState(), health({
    unheadered: true,
    lastMixedFrame: mixedFrame({ unheaderedSamples: 480 }),
  }));
  const result = quality.assessment();
  assert.equal(result.evidence.unheadered, true);
  assert.equal(result.verdict, 'review');
  assert.equal(result.issues.some((issue) => issue.code === 'unheadered-pcm'), true);
});

test('transport changes are review evidence, not proof that audible recording was damaged', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), health());
  quality.noteEvent('mic-transport-disconnected');
  quality.noteEvent('mic-transport-connected');
  quality.observeFrame(960, frameState(), health());

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
