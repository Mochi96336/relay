import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePersistedTakeRichFields } from '../src/take-metadata-validation.js';
import { TakeQualityTracker } from '../src/take-quality.js';

const RATE = 48_000;

function storedQuality() {
  const tracker = new TakeQualityTracker({ sampleRate: RATE });
  tracker.noteTimingAtStart({ appliedCalibrationKind: 'none', estimateSource: 'transport', calibrationError: null });
  tracker.observeFrame(RATE / 100, {
    timingMode: 'network-estimate',
    calibrationStale: false,
    alignmentClamped: false,
    robotRoute: true,
    robotDeltaFresh: true,
    timingDivergenceMs: null,
    estimateSource: 'transport',
  }, {
    micGapSamples: 0,
    backingGapSamples: 0,
    micStarvedSamples: 0,
    backingStarvedSamples: 0,
    micUnavailableSamples: 0,
    backingUnavailableSamples: 0,
    clippedSamples: 0,
    micInputClippedSamples: 0,
    limitedSamples: 10,
    heavyLimitedSamples: 4,
    unheaderedSamples: 0,
  });
  return JSON.parse(JSON.stringify(tracker.assessment()));
}

test('timing provenance and heavy limiting survive storage as v5 quality', () => {
  const quality = storedQuality();
  const normalized = normalizePersistedTakeRichFields({ quality });
  assert.ok(normalized?.quality);
  assert.equal(normalized.quality.evidence.heavyLimitedSamples, 4);
  assert.deepEqual(normalized.quality.evidence.timingAtStart, {
    appliedCalibrationKind: 'none',
    estimateSource: 'transport',
    calibrationError: null,
  });
});

test('a Take stored before provenance existed is still valid', () => {
  const quality = storedQuality();
  for (const field of [
    'heavyLimitedSamples', 'heavyLimitedMs',
    'sampleSongEstimateSamples', 'sampleSongEstimateMs',
    'bootProbeAlignedSamples', 'bootProbeAlignedMs',
    'contentAlignedSamples', 'contentAlignedMs',
    'timingAtStart',
  ]) delete quality.evidence[field];
  assert.ok(normalizePersistedTakeRichFields({ quality })?.quality);
});

test('malformed provenance fails closed', () => {
  const badKind = storedQuality();
  badKind.evidence.timingAtStart.appliedCalibrationKind = 'guess';
  assert.equal(normalizePersistedTakeRichFields({ quality: badKind }), null);

  const halfPair = storedQuality();
  delete halfPair.evidence.heavyLimitedMs;
  assert.equal(normalizePersistedTakeRichFields({ quality: halfPair }), null);
});
