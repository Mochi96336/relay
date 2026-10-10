import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeProbeTimingDiagnostics } from '../src/probe-timing-diagnostics.js';

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
