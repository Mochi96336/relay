import assert from 'node:assert/strict';
import test from 'node:test';

import { implausibleProbeMatch } from '../src/probe-match-plausibility.js';

// Every Mic probe in the journal from 2026-10-28 to 2026-11-14 at or above the
// 0.5 threshold, and whether it should be kept. The two not kept were shown
// wrong on 2026-11-14: the song-based placement disagreed by 104 ms for the
// whole song, and the advance asked for was beyond what the mix can give.
const JOURNAL: [number, number, boolean][] = [
  [0.5, 240, true], [0.518, 235, true], [0.518, 1_485, false], [0.527, 295, true],
  [0.545, 470, true], [0.584, 40, false], [0.598, 260, true], [0.627, 260, true],
  [0.651, 295, true], [0.73, 285, true], [0.733, 240, true], [0.745, 310, true],
  [0.808, 170, true], [0.814, 165, true], [0.818, 180, true], [0.833, 180, true],
  [0.844, 175, true], [0.88, 135, true], [0.944, 140, true], [0.944, 255, true],
];

test("the journal's two wrong matches are rejected and nothing else is", () => {
  for (const [correlation, latencyMs, kept] of JOURNAL) {
    assert.equal(implausibleProbeMatch('mic', correlation, latencyMs) === null, kept, `${correlation} at ${latencyMs} ms`);
  }
});

test('the range is inclusive and the reason names both numbers', () => {
  assert.equal(implausibleProbeMatch('mic', 0.6, 80), null);
  assert.equal(implausibleProbeMatch('mic', 0.6, 800), null);
  assert.match(implausibleProbeMatch('mic', 0.6, 801)!, /0\.600.*801 ms/);
  assert.equal(implausibleProbeMatch('backing', 0.6, 5), null);
});
