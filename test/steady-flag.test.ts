import assert from 'node:assert/strict';
import test from 'node:test';

import { SteadyFlag } from '../src/steady-flag.js';

test('a problem is raised only after it has held, and cleared only after the fix has held longer', () => {
  const flag = new SteadyFlag({ raiseMs: 1_000, clearMs: 3_000 });
  assert.equal(flag.update(true, 0), false);
  assert.equal(flag.update(true, 999), false);
  assert.equal(flag.update(true, 1_000), true);

  assert.equal(flag.update(false, 2_000), true);
  assert.equal(flag.update(false, 4_999), true);
  assert.equal(flag.update(false, 5_000), false);
});

test('a raw value flipping about once a second shows once and stays, instead of flickering', () => {
  // 2026-10-09: Mic playability flipped about once a second on a congested uplink.
  const flag = new SteadyFlag({ raiseMs: 1_000, clearMs: 3_000 });
  const seen: boolean[] = [];
  for (let nowMs = 0; nowMs < 20_000; nowMs += 250) {
    const raw = Math.floor(nowMs / 1_200) % 2 === 0 ? false : true;
    seen.push(flag.update(raw, nowMs));
  }
  const changes = seen.filter((value, index) => index > 0 && value !== seen[index - 1]).length;
  assert.equal(changes, 1, `the steady value changed ${changes} times`);
  assert.equal(seen.at(-1), true);
});

test('a blip shorter than the hold changes nothing', () => {
  const flag = new SteadyFlag({ raiseMs: 1_000, clearMs: 3_000 });
  flag.update(true, 0);
  assert.equal(flag.update(false, 500), false);
  assert.equal(flag.update(true, 700), false, 'the hold restarts once the raw value returns');
  assert.equal(flag.update(true, 1_600), false);
  assert.equal(flag.update(true, 1_700), true);
});
