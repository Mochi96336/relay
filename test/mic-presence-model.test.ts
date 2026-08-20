import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIC_PRESENCE_BAND_COUNT,
  MIC_PRESENCE_SLICE_COUNT,
  centerOriginX,
  createPresenceSlice,
  nextPresenceHistory,
  normalizeSpectrumBands,
  pitchLobeCount,
  presenceSliceGeometry,
  rmsDbfsToPresence,
} from '../public/mic-presence-model.js';
import type { MicPresenceSlice } from '../public/mic-presence-model.js';

test('Mic presence maps true RMS monotonically into ribbon amplitude', () => {
  assert.equal(rmsDbfsToPresence(Number.NaN), 0);
  assert.equal(rmsDbfsToPresence(-80), 0);
  assert.equal(rmsDbfsToPresence(-58), 0);
  assert.ok(rmsDbfsToPresence(-40) > 0);
  assert.ok(rmsDbfsToPresence(-28) > rmsDbfsToPresence(-40));
  assert.equal(rmsDbfsToPresence(-18), 1);
});

test('five-band spectrum remains normalized evidence but does not own pitch', () => {
  assert.deepEqual(normalizeSpectrumBands(null), Array(MIC_PRESENCE_BAND_COUNT).fill(0));
  assert.deepEqual(normalizeSpectrumBands([0, 1, 2, 0.5, 0]), [0, 0.5, 1, 0.25, 0]);

  const lowBands = presenceSliceGeometry(createPresenceSlice(-28, [1, 0, 0, 0, 0], 220, 0.95));
  const highBands = presenceSliceGeometry(createPresenceSlice(-28, [0, 0, 0, 0, 1], 220, 0.95));
  assert.equal(lowBands.amplitude, highBands.amplitude);
  assert.equal(lowBands.density, highBands.density);
});

test('same RMS with low/high F0 keeps amplitude while making high pitch visibly denser', () => {
  const low = presenceSliceGeometry(createPresenceSlice(-28, [1, 0, 0, 0, 0], 100, 0.95));
  const high = presenceSliceGeometry(createPresenceSlice(-28, [1, 0, 0, 0, 0], 600, 0.95));
  assert.equal(low.amplitude, high.amplitude);
  assert.ok(high.density > low.density * 3.5);
  assert.ok(Math.abs(pitchLobeCount(80) - 1.25) < 0.01);
  assert.ok(pitchLobeCount(100) > 1.8 && pitchLobeCount(100) < 2.0);
  assert.ok(pitchLobeCount(150) > 3 && pitchLobeCount(150) < 3.2);
  assert.ok(pitchLobeCount(300) > 5.7 && pitchLobeCount(300) < 5.9);
  assert.ok(pitchLobeCount(440) > 7.2 && pitchLobeCount(440) < 7.4);
  assert.equal(pitchLobeCount(600), 8.5);
  assert.equal(pitchLobeCount(1000), 8.5);
});

test('same F0 with different RMS keeps density while changing amplitude', () => {
  const quiet = presenceSliceGeometry(createPresenceSlice(-45, [0, 1, 0, 0, 0], 220, 0.95));
  const loud = presenceSliceGeometry(createPresenceSlice(-25, [0, 1, 0, 0, 0], 220, 0.95));
  assert.equal(quiet.density, loud.density);
  assert.ok(loud.amplitude > quiet.amplitude);
});

test('missing or low-confidence F0 cannot manufacture pitch texture', () => {
  const none = presenceSliceGeometry(createPresenceSlice(-25, [0, 0, 1, 0, 0], null, 0));
  const uncertain = presenceSliceGeometry(createPresenceSlice(-25, [0, 0, 1, 0, 0], 220, 0.2));
  assert.equal(none.pitchStrength, 0);
  assert.equal(uncertain.pitchStrength, 0);
});

test('center-origin history stores one copy and maps latest evidence to x=50%', () => {
  let history: MicPresenceSlice[] = [];
  for (let index = 0; index < MIC_PRESENCE_SLICE_COUNT; index += 1) {
    history = nextPresenceHistory(history, -30, [1, 0, 0, 0, 0], 220, 0.9);
  }
  assert.equal(history.length, MIC_PRESENCE_SLICE_COUNT);
  const latest = centerOriginX(history.length - 1, history.length, 320);
  assert.equal(latest.left, 160);
  assert.equal(latest.right, 160);
  const oldest = centerOriginX(0, history.length, 320);
  assert.equal(oldest.left, 0);
  assert.equal(oldest.right, 320);
});
