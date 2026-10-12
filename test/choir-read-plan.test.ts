import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { planChoirRead, type ChoirTrackAnchor } from '../src/choir-read-plan.js';

describe('experimental choir sample-position read plan', () => {
  const baseline: ChoirTrackAnchor = {
    participantId: 'participant-a', songEpoch: 7,
    captureGeneration: 2, backingGeneration: 4,
    roomSampleAtAnchor: 96_000, micSampleAtAnchor: 120_000,
    roomSampleRate: 48_000, micSampleRate: 48_000,
  };
  const request = {
    participantId: 'participant-a', songEpoch: 7,
    captureGeneration: 2, backingGeneration: 4,
    roomStartSample: 144_000, frameSamples: 960,
  };

  test('two independently anchored singers read the same song moment despite a 300 ms offset', () => {
    const a = planChoirRead(baseline, request);
    const b = planChoirRead({
      ...baseline,
      participantId: 'participant-b',
      micSampleAtAnchor: baseline.micSampleAtAnchor + 14_400,
    }, { ...request, participantId: 'participant-b' });

    assert.deepEqual(a, { micFirstSample: 168_000, micStep: 1, frameSamples: 960 });
    assert.deepEqual(b, { micFirstSample: 182_400, micStep: 1, frameSamples: 960 });
    assert.equal(b!.micFirstSample - a!.micFirstSample, 14_400);
    // This test verifies only deterministic read positioning, not that Content
    // correlation can actually recover the correct anchors from real audio.
  });

  test('different capture sample rates map one room frame to each source clock', () => {
    const plan = planChoirRead({
      ...baseline,
      micSampleRate: 44_100,
      micSampleAtAnchor: 0,
    }, {
      ...request,
      roomStartSample: 96_480,
      frameSamples: 480,
    });
    assert.ok(plan);
    assert.equal(plan.micStep, 44_100 / 48_000);
    assert.ok(Math.abs(plan.micFirstSample - 441) < 1e-9);
  });

  test('seek, capture restart, backing restart, and wrong singer reject old anchors', () => {
    for (const change of [
      { songEpoch: 8 },
      { captureGeneration: 3 },
      { backingGeneration: 5 },
      { participantId: 'participant-b' },
    ]) {
      assert.equal(planChoirRead(baseline, { ...request, ...change }), null);
    }
  });

  test('rejects invalid anchor or requests rather than producing a bogus read', () => {
    assert.equal(planChoirRead({ ...baseline, roomSampleRate: 0 }, request), null);
    assert.equal(planChoirRead({ ...baseline, micSampleRate: Number.NaN }, request), null);
    assert.equal(planChoirRead({ ...baseline, micSampleAtAnchor: Infinity }, request), null);
    assert.equal(planChoirRead(baseline, { ...request, roomStartSample: -1 }), null);
    assert.equal(planChoirRead(baseline, { ...request, frameSamples: 0 }), null);
  });

  test('signed preroll remains explicit for the future per-track reader', () => {
    const plan = planChoirRead({
      ...baseline, roomSampleAtAnchor: 48_000, micSampleAtAnchor: 0,
    }, { ...request, roomStartSample: 47_520 });
    assert.equal(plan?.micFirstSample, -480);
  });
});
