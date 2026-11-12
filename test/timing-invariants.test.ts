import assert from 'node:assert/strict';
import test from 'node:test';

import { RobotPlayerOffsetTracker } from '../src/robot-player-offset.js';
import { FallbackPlacement, SampleSongFallback, type SongSampleAnchor } from '../src/sample-song-fallback.js';
import { seeded } from './support/seeded-random.js';

/**
 * Invariants of the timing state machines over seeded random input. Each
 * names what must hold for every sequence, where the example tests beside
 * them name single sequences. A failure prints its seed.
 */
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

test('FallbackPlacement: a stable candidate is reached within two confirmations, and far placements are one apart', () => {
  const WALK = 20, CONFIRM = 1000, NOISE = 8;
  let farPlacements = 0, reachChecks = 0;
  for (const seed of SEEDS) {
    const next = seeded(seed);
    const placement = new FallbackPlacement(WALK, CONFIRM);
    let nowMs = 0, current = 0, target = Math.round((next() - .5) * 2000);
    let stableSince: number | null = null, lastPlaceAt: number | null = null, placed = false;
    for (let tick = 0; tick < 600; tick++) {
      nowMs += 10 + Math.floor(next() * 50);
      if (next() < .007) { target += Math.round((next() - .5) * 600); stableSince = null; }
      const lapse = next() < .015;
      const candidate = lapse ? null : target + (next() - .5) * 2 * NOISE;
      if (lapse) stableSince = null; else stableSince ??= nowMs;
      const decision = placement.decide(candidate, current, 'abcdefghijk', nowMs);
      const context = `seed ${seed} tick ${tick} ${JSON.stringify({ decision, candidate, current, target })}`;
      if (candidate === null) assert.equal(decision.kind, 'hold', context);
      if (decision.kind === 'place') {
        assert.equal(decision.ms, candidate, context);
        if (placed) {
          farPlacements += 1;
          assert.ok(nowMs - lastPlaceAt! >= CONFIRM, `two far placements inside one confirmation: ${context}`);
        }
        placed = true; lastPlaceAt = nowMs; current = decision.ms;
      } else if (decision.kind === 'walk') {
        assert.equal(decision.ms, candidate, context);
        assert.ok(Math.abs(decision.ms - current) <= WALK, context);
        current += Math.sign(decision.ms - current) * Math.min(1, Math.abs(decision.ms - current));
      }
      // Agreement with no lapse always lands the voice near the target. Two
      // confirmations bound it, not one: a confirmation already under way for
      // a nearby earlier target restarts when a candidate strays from it.
      if (stableSince !== null && nowMs - stableSince >= 2 * CONFIRM + 120) {
        reachChecks += 1;
        assert.ok(Math.abs(current - target) <= WALK + 2 * NOISE, `not reached: ${context}`);
      }
    }
  }
  // The sequences have to exercise what the invariants are about.
  assert.ok(farPlacements > 100 && reachChecks > 1000, JSON.stringify({ farPlacements, reachChecks }));
});

test('SampleSongFallback: the estimate depends on samples and song time, never on arrival', () => {
  const base: SongSampleAnchor = { videoId: 'abcdefghijk', generation: 1, sampleRate: 48000,
    sampleIndex: 0, mediaSeconds: 10, playbackRate: 1, state: 1, uncertaintyMs: 40 };
  const identity = (_: string, a: SongSampleAnchor) => a.sampleIndex;
  for (const seed of SEEDS) {
    const next = seeded(seed);
    const micOffset = next() * 2, backingOffset = next() * 2;
    const f = new SampleSongFallback();
    // Each side reports 3 to 5 anchors, each delivered up to 200 ms late, the sides interleaved by arrival.
    const reports = (['mic', 'backing'] as const).flatMap(side => {
      const count = 3 + Math.floor(next() * 3);
      return Array.from({ length: count }, (_, i) => ({ side, i, at: 1000 + i * 250 + Math.floor(next() * 200) }));
    }).sort((a, b) => a.at - b.at || a.i - b.i);
    for (const { side, i, at } of reports) {
      const offset = side === 'mic' ? micOffset : backingOffset;
      assert.equal(f.observe(side, { ...base, sampleIndex: (i * .25 + offset) * 48000, mediaSeconds: 10 + i * .25 }, at), true);
    }
    const lastAt = reports.at(-1)!.at;
    const estimate = f.estimate(lastAt, base.videoId, identity, 48000);
    assert.notEqual(estimate, null, `seed ${seed}: ${f.rejection}`);
    assert.ok(Math.abs(estimate! - (micOffset - backingOffset) * 1000) < 1e-6, `seed ${seed}: ${estimate}`);
    // A side whose audio has not landed is awaited; one that cannot be placed is a lapse.
    assert.equal(f.estimate(lastAt, base.videoId, side => side === 'mic' ? 'ahead' : 0, 48000), null);
    assert.equal(f.rejection, 'awaiting-audio', `seed ${seed}`);
    assert.equal(f.estimate(lastAt + 1001 + 200, base.videoId, identity, 48000), null);
    assert.match(String(f.rejection), /-stale$/, `seed ${seed}`);
  }
});

test('RobotPlayerOffsetTracker: the offset is a recent report, bounded by them, and expires', () => {
  for (const seed of SEEDS) {
    const next = seeded(seed);
    const tracker = new RobotPlayerOffsetTracker({ freshForMs: 2000, windowMs: 2000, maxAbsOffsetMs: 450 });
    let nowMs = 0;
    let recent: { offsetMs: number; atMs: number }[] = [];
    for (let i = 0; i < 300; i++) {
      nowMs += 50 + Math.floor(next() * 400);
      const offsetMs = (next() - .5) * 1000;
      const accepted = tracker.record(offsetMs, nowMs);
      assert.equal(accepted, Math.abs(offsetMs) <= 450, `seed ${seed} report ${i}`);
      // A report outside the follower's range is convergence: nothing before it may answer.
      recent = accepted ? [...recent, { offsetMs, atMs: nowMs }].filter(s => s.atMs >= nowMs - 2000) : [];
      const offset = tracker.offsetMs(nowMs);
      if (recent.length === 0) {
        assert.equal(offset, null, `seed ${seed} report ${i}`);
        assert.equal(tracker.isFresh(nowMs), false);
        continue;
      }
      const values = recent.map(s => s.offsetMs);
      assert.ok(offset! >= Math.min(...values) && offset! <= Math.max(...values), `seed ${seed} report ${i}`);
      assert.ok(Math.abs(offset!) <= 450);
      assert.equal(tracker.isFresh(nowMs + 2000), true);
      assert.equal(tracker.isFresh(nowMs + 2001), false);
    }
    assert.equal(tracker.offsetMs(nowMs + 2001), null, `seed ${seed}: history outlived`);
  }
});
