import assert from 'node:assert/strict';
import test from 'node:test';

import { ProductMicSteadiness, type ProductMicFacts } from '../src/product-mic-steadiness.js';

const LIVE: ProductMicFacts = {
  capture: 7,
  flowObserved: true,
  streaming: true,
  audibilityDegraded: false,
  inTransit: false,
};

test('a starting capture reads starting, not interrupted, until it plays or its grace runs out', () => {
  const mic = new ProductMicSteadiness();
  const arriving = { ...LIVE, streaming: false };
  assert.equal(mic.observe(arriving, 0).flowObserved, false, 'arriving, not yet playable: starting');
  assert.equal(mic.observe(arriving, 2_999).flowObserved, false);
  assert.deepEqual(mic.observe(LIVE, 3_100), LIVE, 'playable: live at once, nothing held');

  const neverPlays = new ProductMicSteadiness();
  neverPlays.observe(arriving, 0);
  const late = neverPlays.observe(arriving, ProductMicSteadiness.STARTUP_GRACE_MS);
  assert.equal(late.flowObserved, true, 'a capture that never plays reads interrupted after the grace');
  assert.equal(late.streaming, false);
});

test('once live, a dropout is raised after 1 s and cleared after 2 s', () => {
  const mic = new ProductMicSteadiness();
  mic.observe(LIVE, 0);
  const dropped = { ...LIVE, streaming: false };
  assert.equal(mic.observe(dropped, 100).streaming, true);
  assert.equal(mic.observe(dropped, 1_100).streaming, false);
  assert.equal(mic.observe(LIVE, 1_200).streaming, false);
  assert.equal(mic.observe(LIVE, 3_199).streaming, false);
  assert.equal(mic.observe(LIVE, 3_200).streaming, true);
});

test('audio in transit stays the explanation while the warning it explains is held', () => {
  // 2026-10-09: the warning outlived the transit episode and its last seconds
  // read "retry Mic".
  const mic = new ProductMicSteadiness();
  mic.observe(LIVE, 0);
  const queued = { ...LIVE, streaming: false, inTransit: true };
  mic.observe(queued, 100);
  assert.deepEqual(
    { streaming: mic.observe(queued, 1_200).streaming, inTransit: mic.observe(queued, 1_200).inTransit },
    { streaming: false, inTransit: true },
  );
  const caughtUp = { ...LIVE, inTransit: false };
  for (const atMs of [1_300, 2_000, 3_000]) {
    const facts = mic.observe(caughtUp, atMs);
    assert.equal(facts.streaming, false, `still held at ${atMs}`);
    assert.equal(facts.inTransit, true, `explained as the network at ${atMs}`);
  }
  const cleared = mic.observe(caughtUp, 3_300);
  assert.equal(cleared.streaming, true);
  assert.equal(cleared.inTransit, false);
});

test('a new capture starts over', () => {
  const mic = new ProductMicSteadiness();
  mic.observe(LIVE, 0);
  mic.observe({ ...LIVE, streaming: false }, 100);
  mic.observe({ ...LIVE, streaming: false }, 1_200);
  const next = mic.observe({ ...LIVE, capture: 8, streaming: false }, 1_300);
  assert.equal(next.flowObserved, false, 'the new capture is starting');
});
