import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeTimelineTracker } from '../src/youtube-timeline.js';
import { seeded } from './support/seeded-random.js';

/**
 * The phone plays from t = 0 at 1x, reports every 250 ms, and each report
 * travels `transit(t)` ms. The page reports its best round trip, and these
 * reports carry no sample time (an older page), so the server assumes every
 * report travelled for half of it. Reports with a sample time are covered in
 * youtube-timeline-report-transit.test.ts.
 */
function run(options: {
  transit: (sentAtMs: number) => number;
  rttMs?: (sentAtMs: number) => number;
  reading?: (sentAtMs: number) => number;
  untilMs?: number;
}) {
  const tracker = new YouTubeTimelineTracker();
  const untilMs = options.untilMs ?? 20_000;
  const reports = [];
  for (let t = 0; t <= untilMs; t += 250) {
    reports.push({ arrive: t + options.transit(t), payload: { videoId: 'dQw4w9WgXcQ', state: 1, duration: 1000,
      currentTime: 10 + (t + (options.reading?.(t) ?? 0)) / 1000, playbackRate: 1, networkRttMs: options.rttMs?.(t) ?? 300 } });
  }
  reports.sort((a, b) => a.arrive - b.arrive);
  const errorAt: Record<number, number> = {};
  let next = 0;
  for (let now = 0; now <= untilMs; now += 50) {
    while (next < reports.length && reports[next].arrive <= now) tracker.update(reports[next].payload, reports[next++].arrive);
    const status = tracker.statusPayload(now) as Record<string, any>;
    if (status.connected) errorAt[now] = (status.serverTime - (10 + now / 1000)) * 1000;
  }
  return { tracker, errorAt, status: tracker.statusPayload(untilMs) as Record<string, any> };
}

test('an anchor taken from a delayed report is moved up to the reports that follow it', () => {
  // The first report takes 180 ms longer than the path's 150 ms; the rest are on time.
  const { errorAt, status } = run({ transit: t => t === 0 ? 330 : 150 });
  assert.ok(Math.abs(errorAt[1000] + 180) < 1, `the room clock starts 180 ms behind the player: ${errorAt[1000]}`);
  assert.ok(Math.abs(errorAt[3000]) < 1, `and is on the player two seconds later: ${errorAt[3000]}`);
  assert.ok(Math.abs(errorAt[20_000]) < 1);
  assert.equal(status.refinements, 1);
  assert.ok(Math.abs(status.lastRefinementMs - 180) < 1);
  // The song did not jump: nothing that bumps the room song revision happened.
  assert.equal(status.corrections, 0);
  assert.equal(status.phaseCorrections, 0);
});

test('reports that are all late while the anchor settles are no evidence, and later ones come too late', () => {
  // The anchor report is 180 ms late, and the path stays congested (400 ms extra) past the settling window.
  const { errorAt, status } = run({ transit: t => t === 0 ? 330 : t < 6_500 ? 150 + 400 : 150 });
  assert.equal(status.refinements, 0);
  // As before this rule existed: under the 450 ms phase threshold nothing moves it.
  assert.ok(Math.abs(errorAt[20_000] + 180) < 1, String(errorAt[20_000]));
});

test('jitter after an on-time anchor never moves the clock, in either direction', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const next = seeded(seed);
    const { status, errorAt } = run({ transit: t => t === 0 ? 150 : 150 - 80 * Math.log(1 - next()) });
    assert.equal(status.refinements, 0, `seed ${seed}`);
    assert.ok(Math.abs(errorAt[20_000]) < 1, `seed ${seed}: ${errorAt[20_000]}`);
  }
});

test('the clock is never moved ahead of the player by delayed reports', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = seeded(seed * 31);
    const spike = () => (next() < .05 ? 100 + next() * 300 : 0);
    const { errorAt } = run({ transit: () => 150 - 25 * Math.log(1 - next()) + spike() });
    for (const [at, error] of Object.entries(errorAt)) {
      assert.ok(error < 1, `seed ${seed} at ${at} ms: ${error} ms ahead`);
    }
    assert.ok(errorAt[20_000] > -45, `seed ${seed}: still ${errorAt[20_000]} ms behind`);
  }
});

test('one reading ahead of the rest does not move the clock', () => {
  const { status } = run({ transit: () => 150, reading: t => t === 1000 ? 200 : 0 });
  assert.equal(status.refinements, 0);
});

test('a round trip that grew since the anchor is not evidence the player is ahead', () => {
  // Downlink congestion: the page's round trip estimate rises 200 ms, its reports travel as before.
  const { status, errorAt } = run({ transit: () => 150, rttMs: t => t >= 1000 ? 500 : 300 });
  assert.equal(status.refinements, 0);
  assert.ok(Math.abs(errorAt[20_000]) < 1, String(errorAt[20_000]));
});

test('a path that gets faster later does not move a settled anchor', () => {
  // The uplink is 60 ms faster from 10 s; the page measures the new round trip 5 s later.
  const { status, errorAt } = run({ transit: t => t >= 10_000 ? 90 : 150, rttMs: t => t >= 15_000 ? 180 : 300 });
  assert.equal(status.refinements, 0);
  assert.ok(Math.abs(errorAt[20_000]) < 1, String(errorAt[20_000]));
});

test('a pause, a seek and a new song each start a new settling window', () => {
  const tracker = new YouTubeTimelineTracker();
  const report = (state: number, currentTime: number, videoId = 'dQw4w9WgXcQ') =>
    ({ videoId, state, duration: 1000, currentTime, playbackRate: 1, networkRttMs: 300 });
  const playFrom = (startMs: number, position: number, lateMs: number, videoId?: string) => {
    for (let t = 0; t <= 3000; t += 250) {
      tracker.update(report(1, position + t / 1000, videoId), startMs + t + 150 + (t === 0 ? lateMs : 0));
    }
  };
  playFrom(0, 10, 120);
  assert.equal((tracker.statusPayload(3200) as Record<string, any>).refinements, 1);
  tracker.update(report(2, 13), 20_000 + 150);
  playFrom(21_000, 13, 90);
  assert.equal((tracker.statusPayload(24_200) as Record<string, any>).refinements, 2, 'after a pause');
  playFrom(40_000, 100, 70);
  assert.equal((tracker.statusPayload(43_200) as Record<string, any>).refinements, 3, 'after a seek');
  playFrom(60_000, 0, 60, 'abcdefghijk');
  const status = tracker.statusPayload(63_200) as Record<string, any>;
  assert.equal(status.refinements, 4, 'after a new song');
  assert.ok(Math.abs(status.lastRefinementMs - 60) < 1);
  assert.equal(status.lastReason, 'tracking');
});
