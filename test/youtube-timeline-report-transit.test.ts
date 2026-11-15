import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeTimelineTracker } from '../src/youtube-timeline.js';
import { seeded } from './support/seeded-random.js';

/** The page's clock reads this much less than the server's; neither side knows it. */
const PAGE_CLOCK_BEHIND_MS = 987_654;

/**
 * The phone plays from t = 0 at 1x and reports every 250 ms with the time it
 * sampled its player. Each report travels `transit(t)` ms, in order, as on
 * the control socket. `targetError` is
 * what the Robot follows (the newest report, projected) minus where the
 * player really is, at every 50 ms.
 */
function run(options: {
  transit: (sentAtMs: number) => number;
  rttMs?: (sentAtMs: number) => number;
  generation?: (sentAtMs: number) => number;
  pageClock?: (sentAtMs: number) => unknown;
  send?: (sentAtMs: number) => boolean;
  untilMs?: number;
}) {
  const tracker = new YouTubeTimelineTracker();
  const untilMs = options.untilMs ?? 30_000;
  const reports = [];
  for (let t = 0; t <= untilMs; t += 250) {
    if (options.send && !options.send(t)) continue;
    reports.push({ arrive: t + options.transit(t), payload: { videoId: 'dQw4w9WgXcQ', state: 1, duration: 1000,
      currentTime: 10 + t / 1000, playbackRate: 1, networkRttMs: options.rttMs?.(t) ?? 300,
      sampledAtPerformanceMs: options.pageClock ? options.pageClock(t) : t - PAGE_CLOCK_BEHIND_MS + 2_000_000,
      playbackTransportId: 'tab', playbackGeneration: options.generation?.(t) ?? 1 } });
  }
  // One ordered connection carries them: a report held up holds up those sent after it.
  for (let i = 1; i < reports.length; i += 1) reports[i].arrive = Math.max(reports[i].arrive, reports[i - 1].arrive);
  const targetError: Record<number, number> = {};
  let next = 0;
  for (let now = 0; now <= untilMs; now += 50) {
    while (next < reports.length && reports[next].arrive <= now) tracker.update(reports[next].payload, reports[next++].arrive);
    const status = tracker.statusPayload(now) as Record<string, any>;
    if (status.connected) targetError[now] = (status.youtubeTime - (10 + now / 1000)) * 1000;
  }
  const after = (fromMs: number) => Object.entries(targetError).filter(([at]) => Number(at) >= fromMs).map(([, error]) => error);
  return { tracker, targetError, after, status: tracker.statusPayload(untilMs) as Record<string, any> };
}
const worst = (errors: number[]) => errors.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0);

test('a report that travelled longer is known to be older, not taken for a player that fell behind', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const next = seeded(seed * 17);
    const jitter = () => -25 * Math.log(1 - next()) + (next() < .05 ? 100 + next() * 300 : 0);
    const { after } = run({ transit: () => 150 + jitter() });
    // Once one report has travelled near the path's best, the rest are measured against it.
    assert.ok(Math.abs(worst(after(5_000))) < 12, `seed ${seed}: ${worst(after(5_000))} ms`);
  }
  // The same reports without a sample time put the player behind by each one's delay.
  const next = seeded(17);
  const legacy = run({ transit: () => 150 - 25 * Math.log(1 - next()), pageClock: () => undefined });
  assert.ok(worst(legacy.after(5_000)) < -60, String(worst(legacy.after(5_000))));
});

test('a congested uplink does not move the player', () => {
  // Every report from 10 to 20 s takes 200 ms longer.
  const { after } = run({ transit: t => 150 + (t >= 10_000 && t < 20_000 ? 200 : 0) });
  assert.ok(Math.abs(worst(after(1_000))) < 1, String(worst(after(1_000))));
});

test('a round trip that rises for a while does not move the player', () => {
  // A congested downlink: the page's best round trip is 400 ms higher from 10 to 20 s.
  const { after } = run({ transit: () => 150, rttMs: t => t >= 10_000 && t < 20_000 ? 700 : 300 });
  assert.ok(Math.abs(worst(after(1_000))) < 1, String(worst(after(1_000))));
});

test('an anchor taken from a delayed report is placed right at once when the clock is known', () => {
  // Paused reports arrive on time; the first playing report is 180 ms late.
  const tracker = new YouTubeTimelineTracker();
  const report = (t: number, state: number, currentTime: number) => ({ videoId: 'dQw4w9WgXcQ', state, duration: 1000,
    currentTime, playbackRate: 1, networkRttMs: 300, sampledAtPerformanceMs: t + 5_000,
    playbackTransportId: 'tab', playbackGeneration: 1 });
  for (let t = 0; t < 2_000; t += 250) tracker.update(report(t, 2, 10), t + 150);
  tracker.update(report(2_000, 1, 10), 2_000 + 150 + 180);
  const status = tracker.statusPayload(2_400) as Record<string, any>;
  assert.ok(Math.abs(status.serverTime - 10.4) < .001, String(status.serverTime));
  assert.equal(status.refinements, 0);
});

test('another page load is another clock, and a silence may have stopped the old one', () => {
  // The reload's clock starts near zero: 2,000 s less than the old page's.
  const reload = run({ transit: () => 150, generation: t => t >= 10_000 ? 2 : 1,
    pageClock: t => t >= 10_000 ? t - 10_000 : t + 2_000_000 });
  assert.ok(Math.abs(worst(reload.after(1_000))) < 1, String(worst(reload.after(1_000))));
  // The page sleeps for 4 s and its clock does not tick meanwhile.
  const slept = run({ transit: () => 150, send: t => t < 10_000 || t >= 14_000,
    pageClock: t => (t >= 14_000 ? t - 4_000 : t) + 50_000 });
  assert.ok(Math.abs(worst(slept.after(14_500))) < 1, String(worst(slept.after(14_500))));
});

test('a page clock that steps cannot be travel time, and the estimate starts over at once', () => {
  // The page clock loses 1.5 s at 10 s without a gap in the reports: no report can be 1.5 s older than
  // one that arrived 250 ms before it.
  const { after, status } = run({ transit: () => 150, pageClock: t => (t >= 10_000 ? t - 1_500 : t) + 50_000 });
  assert.ok(Math.abs(worst(after(1_000))) < 1, String(worst(after(1_000))));
  assert.equal(status.corrections, 0);
});

test('a connection that stalls for 1.2 s and floods is neither a jump nor a player that fell behind', () => {
  // Nothing sent from 10 s arrives before 11.2 s; then everything arrives at once, 1.45 s after the last report.
  const stalled = run({ transit: t => 150 + (t >= 10_000 && t < 11_200 ? 11_200 - t : 0) });
  for (const at of [11_400, 12_000, 15_000]) {
    assert.ok(Math.abs(stalled.targetError[at]) < 1, `${at}: ${stalled.targetError[at]}`);
  }
  // No seek was seen, so the room clock was not re-anchored and the room song revision did not move.
  assert.equal(stalled.status.corrections, 0);
  assert.equal(stalled.status.reanchors, 0);
  // Without sample times the same burst reads as the player jumping back 1.2 s and then forward again.
  const legacy = run({ transit: t => 150 + (t >= 10_000 && t < 11_200 ? 11_200 - t : 0), pageClock: () => undefined });
  assert.ok(legacy.status.corrections >= 1, JSON.stringify(legacy.status.corrections));
});

test('a sample time that is not a usable number falls back to half the round trip', () => {
  for (const bad of [undefined, null, 'soon', Number.NaN, -5, Number.POSITIVE_INFINITY]) {
    const { after } = run({ transit: t => t === 5_000 ? 350 : 150, pageClock: () => bad });
    const errors = after(1_000);
    assert.ok(Math.abs(errors[0]) < 1, `${String(bad)}: ${errors[0]}`);
    assert.ok(worst(errors) < -150, `${String(bad)}: the late report is still taken as on time: ${worst(errors)}`);
  }
});

test('the room song session gives its own readings no page sample time', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/song-session.ts', import.meta.url), 'utf8');
  // Both places that replace a report's position with the room's own must drop the page's sample time.
  const rewrites = source.match(/currentTime: (?:before|room)\.serverTime,[^}]*\}/g) ?? [];
  assert.equal(rewrites.length, 2, rewrites.join('\n'));
  for (const rewrite of rewrites) assert.match(rewrite, /sampledAtPerformanceMs: undefined/);
});

test('RELAY_SONG_REPORT_TRAVEL_TIME=0 keeps the old reading of every report', async () => {
  const { loadRelayConfig } = await import('../src/config.js');
  assert.equal(loadRelayConfig({}).songReportTravelTime, true);
  assert.equal(loadRelayConfig({ RELAY_SONG_REPORT_TRAVEL_TIME: '0' }).songReportTravelTime, false);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
    /new SongSession\(\{ reportTravelTime: relayConfig\.songReportTravelTime \}\)/);
  const { SongSession } = await import('../src/song-session.js');
  assert.match(readFileSync(new URL('../src/song-session.ts', import.meta.url), 'utf8').replace(/\s+/g, ' '),
    /this\.timeline = new YouTubeTimelineTracker\(timelineOptions\)/);
  assert.ok(new SongSession({ reportTravelTime: false }));
  // Off: a late report is taken as on time, and a late anchor is not moved.
  const tracker = new YouTubeTimelineTracker({ reportTravelTime: false });
  for (let t = 0; t <= 5_000; t += 250) {
    tracker.update({ videoId: 'dQw4w9WgXcQ', state: 1, duration: 1000, currentTime: 10 + t / 1000, playbackRate: 1,
      networkRttMs: 300, sampledAtPerformanceMs: t + 9_000, playbackTransportId: 'tab', playbackGeneration: 1 },
    t + (t === 0 || t === 5_000 ? 330 : 150));
  }
  const status = tracker.statusPayload(5_330) as Record<string, any>;
  assert.equal(status.refinements, 0);
  assert.ok(Math.abs((status.serverTime - 15.33) * 1000 + 180) < 1, String(status.serverTime));
  assert.ok(Math.abs((status.youtubeTime - 15.33) * 1000 + 180) < 1, String(status.youtubeTime));
});
