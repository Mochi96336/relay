import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIC_PRESENCE_BAND_COUNT,
  MIC_PRESENCE_SLICE_COUNT,
  createPresenceSlice,
  nextPresenceHistory,
  normalizeSpectrumBands,
  rmsDbfsToPresence,
} from '../public/mic-presence-model.js';

test('Mic presence maps local RMS monotonically without turning into a clipping meter', () => {
  assert.equal(rmsDbfsToPresence(Number.NaN), 0);
  assert.equal(rmsDbfsToPresence(-80), 0);
  assert.equal(rmsDbfsToPresence(-58), 0);
  assert.ok(rmsDbfsToPresence(-40) > 0);
  assert.ok(rmsDbfsToPresence(-28) > rmsDbfsToPresence(-40));
  assert.equal(rmsDbfsToPresence(-18), 1);
  assert.equal(rmsDbfsToPresence(-3), 1);
});

test('spectrum shape stays five-band and normalizes frequency colour independently of RMS', () => {
  assert.deepEqual(normalizeSpectrumBands(null), Array(MIC_PRESENCE_BAND_COUNT).fill(0));
  assert.deepEqual(normalizeSpectrumBands([0, 0.5, 1, 0.25, 0]), [0, 0.5, 1, 0.25, 0]);
  assert.deepEqual(normalizeSpectrumBands([0, 1, 2, 0.5, 0]), [0, 0.5, 1, 0.25, 0]);

  const low = createPresenceSlice(-28, [1, 0.4, 0.1, 0, 0]);
  const high = createPresenceSlice(-28, [0, 0, 0.1, 0.5, 1]);
  assert.equal(low.bands.length, MIC_PRESENCE_BAND_COUNT);
  assert.equal(high.bands.length, MIC_PRESENCE_BAND_COUNT);
  assert.ok(low.bands[0] > low.bands[4]);
  assert.ok(high.bands[4] > high.bands[0]);
  assert.equal(low.presence, high.presence, 'frequency shape must not manufacture extra loudness');
});

test('Mic ribbon keeps about 400 ms of truthful local evidence flowing left', () => {
  let history = [];
  for (let index = 0; index < MIC_PRESENCE_SLICE_COUNT; index += 1) {
    const bands = index === MIC_PRESENCE_SLICE_COUNT - 1
      ? [0, 0, 0, 0, 1]
      : [1, 0, 0, 0, 0];
    history = nextPresenceHistory(history, -30, bands);
  }

  assert.equal(history.length, MIC_PRESENCE_SLICE_COUNT);
  assert.ok(history[0].bands[0] > history[0].bands[4], 'oldest evidence remains on the left');
  assert.ok(
    history[MIC_PRESENCE_SLICE_COUNT - 1].bands[4] > history[MIC_PRESENCE_SLICE_COUNT - 1].bands[0],
    'newest evidence enters on the right',
  );
});
