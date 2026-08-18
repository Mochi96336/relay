import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIC_PRESENCE_BAR_COUNT,
  nextPresenceHistory,
  presenceHeightPx,
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

test('Mic presence is a fixed short history of real local level samples', () => {
  let history: number[] = [];
  history = nextPresenceHistory(history, -58);
  history = nextPresenceHistory(history, -42);
  history = nextPresenceHistory(history, -30);
  history = nextPresenceHistory(history, -24);
  history = nextPresenceHistory(history, -36);

  assert.equal(history.length, MIC_PRESENCE_BAR_COUNT);
  assert.equal(history[0], 0);
  assert.ok(history[1] > history[0]);
  assert.ok(history[2] > history[1]);
  assert.ok(history[3] > history[2]);
  assert.ok(history[4] < history[3]);
});

test('Presence bars retain a quiet physical baseline but grow with measured voice', () => {
  assert.equal(presenceHeightPx(0), 5);
  assert.ok(presenceHeightPx(0.5) > presenceHeightPx(0));
  assert.equal(presenceHeightPx(1), 34);
});
