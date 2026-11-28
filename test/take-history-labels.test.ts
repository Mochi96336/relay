import assert from 'node:assert/strict';
import test from 'node:test';
import { takeTimeLabels } from '../public/take-history-labels.js';

const at = (takeId: string, endedAtMs: number) => ({ takeId, endedAtMs });
// A stand-in for the page's to-the-second clock.
const seconds = (ms: number) => `t${Math.floor(ms / 1000)}`;

test('Takes in different seconds read as their time; the same second adds an ordinal', () => {
  const labels = takeTimeLabels([at('b', 61_400), at('a', 60_100), at('c', 61_900), at('d', 75_000)], seconds);
  assert.equal(labels.get('a'), 't60');
  assert.equal(labels.get('b'), 't61');
  assert.equal(labels.get('c'), 't61 (2)', 'recording order, whatever the list order');
  assert.equal(labels.get('d'), 't75');
  assert.equal(new Set(labels.values()).size, 4, 'every label distinct');
});

test('a later Take never relabels an earlier one', () => {
  const before = takeTimeLabels([at('a', 61_100), at('b', 61_500)], seconds);
  const after = takeTimeLabels([at('c', 61_800), at('a', 61_100), at('b', 61_500)], seconds);
  assert.equal(after.get('a'), before.get('a'));
  assert.equal(after.get('b'), before.get('b'));
  assert.equal(after.get('c'), 't61 (3)');
});
