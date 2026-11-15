import assert from 'node:assert/strict';
import test from 'node:test';
import { probeScheduleTime, sanitizeProbeTimingDiagnostics } from '../src/probe-timing-diagnostics.js';

test('probe evidence preserves zero and drops nonnumeric, unbounded and unrelated data', () => {
  const result = sanitizeProbeTimingDiagnostics({ processingMs: 0,
    baseLatencyMs: 12, outputLatencyMs: Infinity, contextSeconds: '4',
    scheduledContextSeconds: -1, outputPerformanceMs: 1e13, secret: 'ignored' });
  assert.equal(result?.processingMs, 0);
  assert.equal(result?.baseLatencyMs, 12);
  assert.equal(result?.outputLatencyMs, null);
  assert.equal(result?.contextSeconds, null);
  assert.equal(result?.scheduledContextSeconds, null);
  assert.equal(result?.outputPerformanceMs, null);
  assert.equal(result?.secret, undefined);
});

test('old clients may omit optional timing evidence', () => {
  assert.equal(sanitizeProbeTimingDiagnostics(undefined), null);
  assert.equal(sanitizeProbeTimingDiagnostics(null), null);
  assert.equal(sanitizeProbeTimingDiagnostics('invalid'), null);
});

test('slow local resume is not mistaken for network transit when locating a probe', () => {
  // 20 ms downlink + 200 ms resume + 4 ms node setup + 20 ms uplink.
  // Nodes are scheduled at wall 220 ms for playback at 420 ms.
  const schedule = probeScheduleTime(0, 244, 200, {
    processingMs: 204, schedulingDelayMs: 200,
  });
  assert.equal(schedule.targetAtMs, 420);
  assert.equal(schedule.transportOneWayMs, 20);
  assert.equal(schedule.method, 'processing-separated');
  assert.equal(probeScheduleTime(0, 244, 200, null).targetAtMs, 322,
    'legacy RTT/2 is 98 ms early for this known sequence of events');
});

test('absolute browser clock origin cannot affect probe scheduling', () => {
  const client = { processingMs: 10, schedulingDelayMs: 8, acknowledgedAtMs: 1e9 };
  assert.equal(probeScheduleTime(100, 150, 200, client).targetAtMs, 328);
  client.acknowledgedAtMs = 0;
  assert.equal(probeScheduleTime(100, 150, 200, client).targetAtMs, 328);
});

test('missing or impossible local durations retain the compatible RTT/2 target', () => {
  for (const client of [null, { processingMs: 10, schedulingDelayMs: null },
    { processingMs: 51, schedulingDelayMs: 10 }, { processingMs: 10, schedulingDelayMs: 11 },
    { processingMs: -1, schedulingDelayMs: 0 }, { processingMs: 1, schedulingDelayMs: NaN }]) {
    const schedule = probeScheduleTime(100, 150, 200, client);
    assert.equal(schedule.targetAtMs, 325);
    assert.equal(schedule.method, 'legacy-rtt-half');
  }
  assert.equal(probeScheduleTime(100, 150, 200, { processingMs: 0, schedulingDelayMs: 0 }).targetAtMs, 325);
});

/**
 * One probe exchange: the request takes `down` ms, the page spends 204 ms
 * (200 before the nodes are scheduled) and the reply takes `up` ms. The
 * page's clock reads `PAGE_BEHIND` less than the server's.
 */
const PAGE_BEHIND = 5_000_000;
function exchange(down: number, up: number) {
  const sentAtMs = 1_000;
  const pageReceivedAtMs = sentAtMs + down;
  return {
    sentAtMs,
    receivedAtMs: pageReceivedAtMs + 204 + up,
    client: { processingMs: 204, schedulingDelayMs: 200, acknowledgedAtMs: pageReceivedAtMs + 204 - PAGE_BEHIND },
    scheduledAtMs: pageReceivedAtMs + 200,
  };
}

test('a known page clock times the probe whatever each leg of the exchange took', () => {
  for (const [down, up] of [[150, 150], [150, 310], [310, 150], [20, 700], [700, 20]]) {
    const { sentAtMs, receivedAtMs, client, scheduledAtMs } = exchange(down, up);
    const schedule = probeScheduleTime(sentAtMs, receivedAtMs, 200, client, PAGE_BEHIND);
    assert.equal(schedule.method, 'page-clock');
    assert.equal(schedule.targetAtMs, scheduledAtMs + 200, `${down}/${up}`);
    assert.equal(schedule.transportOneWayMs, down);
    // Without it the same exchange is off by half the difference of the legs:
    // the 2026-10-31 pair, 140 and 60 ms from one capture, is a reply 160 ms late.
    const assumed = probeScheduleTime(sentAtMs, receivedAtMs, 200, client);
    assert.equal(assumed.method, 'processing-separated');
    assert.equal(assumed.targetAtMs - (scheduledAtMs + 200), (up - down) / 2, `${down}/${up}`);
  }
});

test('a page clock that could not be true of this exchange is not used', () => {
  const { sentAtMs, receivedAtMs, client } = exchange(150, 150);
  const assumed = probeScheduleTime(sentAtMs, receivedAtMs, 200, client).targetAtMs;
  // Received before it was sent, or acknowledged after the reply arrived: another tab's clock, or a stale one.
  for (const offset of [PAGE_BEHIND - 156, PAGE_BEHIND + 156, PAGE_BEHIND + 60_000, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const schedule = probeScheduleTime(sentAtMs, receivedAtMs, 200, client, offset);
    assert.equal(schedule.method, 'processing-separated', String(offset));
    assert.equal(schedule.targetAtMs, assumed);
  }
  // Within the exchange, off by what the room clock's own estimate can be off by: used as given.
  for (const offset of [PAGE_BEHIND - 150, PAGE_BEHIND + 150, PAGE_BEHIND + 40]) {
    assert.equal(probeScheduleTime(sentAtMs, receivedAtMs, 200, client, offset).method, 'page-clock', String(offset));
  }
  // No acknowledgement time, or durations that cannot be: as before.
  assert.equal(probeScheduleTime(sentAtMs, receivedAtMs, 200,
    { processingMs: 204, schedulingDelayMs: 200, acknowledgedAtMs: null }, PAGE_BEHIND).method, 'processing-separated');
  assert.equal(probeScheduleTime(sentAtMs, receivedAtMs, 200, null, PAGE_BEHIND).method, 'legacy-rtt-half');
});

test('only the Mic leg is timed on the page clock, and only on the singer\'s own page', async () => {
  const { readFileSync } = await import('node:fs');
  const coordinator = readFileSync(new URL('../src/boot-probe-coordinator.ts', import.meta.url), 'utf8');
  assert.match(coordinator.replace(/\s+/g, ' '),
    /probeScheduleTime\(pending\.serverSentAtMs, nowMs, this\.config\.leadMs, client, pending\.target === 'mic' \? this\.host\.micPageClockOffsetMs\?\.\(nowMs\) \?\? null : null\)/);
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(server, /micPageClockOffsetMs: \(nowMs\) => \{ const clock = youtubeTimeline\.leaderPageClock\(nowMs\); return clock && clock\.participantId === participants\.micOwnerId \? clock\.offsetMs : null; \}/);
  // Choir B's probe is timed as before: its page is not the room clock's.
  const choir = readFileSync(new URL('../src/choir-probe.ts', import.meta.url), 'utf8');
  assert.match(choir, /probeScheduleTime\(this\.sentAtMs, nowMs, this\.config\.leadMs, client\);/);
});
