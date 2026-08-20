import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TERMINAL_HANDOFF_LEAD_SECONDS,
  handoffPreparationPosition,
} from '../public/playback-handoff-timing.js';

test('ended playback prepares just before the terminal position', () => {
  assert.equal(
    handoffPreparationPosition(311.121, 0),
    311.121 - TERMINAL_HANDOFF_LEAD_SECONDS,
  );
  assert.equal(handoffPreparationPosition(0.1, -1), 0);
});

test('playing and paused handoffs preserve the authoritative position', () => {
  assert.equal(handoffPreparationPosition(42.5, 1), 42.5);
  assert.equal(handoffPreparationPosition(42.5, 2), 42.5);
});

test('invalid handoff positions fail closed at the start', () => {
  assert.equal(handoffPreparationPosition(Number.NaN, 0), 0);
  assert.equal(handoffPreparationPosition(-5, 0), 0);
});
