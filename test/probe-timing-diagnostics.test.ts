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
