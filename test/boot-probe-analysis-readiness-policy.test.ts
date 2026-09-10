import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideBootProbeAnalysisReadiness,
  type BootProbeAnalysisReadinessInput,
} from '../src/boot-probe-analysis-readiness-policy.js';

function facts(
  overrides: Partial<BootProbeAnalysisReadinessInput> = {},
): BootProbeAnalysisReadinessInput {
  return {
    sessionCurrent: true,
    captureGenerationMatches: true,
    nowMs: 900,
    deadlineMs: 1_000,
    reachedSamples: 1_200,
    neededSamples: 1_200,
    ...overrides,
  };
}

test('stale session identity wins over generation, timeout and sample readiness', () => {
  assert.deepEqual(decideBootProbeAnalysisReadiness(facts({
    sessionCurrent: false,
    captureGenerationMatches: false,
    nowMs: 2_000,
    reachedSamples: 2_000,
  })), { kind: 'abandon', reason: 'session' });
});

test('capture generation mismatch wins over timeout', () => {
  assert.deepEqual(decideBootProbeAnalysisReadiness(facts({
    captureGenerationMatches: false,
    nowMs: 2_000,
  })), { kind: 'abandon', reason: 'capture-generation' });
});

test('deadline remains strict rather than expiring exactly on the boundary', () => {
  assert.deepEqual(decideBootProbeAnalysisReadiness(facts({
    nowMs: 1_000,
  })), { kind: 'ready' });
  assert.deepEqual(decideBootProbeAnalysisReadiness(facts({
    nowMs: 1_001,
  })), { kind: 'timeout' });
});

test('timeout wins even when the requested window has reached the analyzer', () => {
  assert.deepEqual(decideBootProbeAnalysisReadiness(facts({
    nowMs: 1_001,
    reachedSamples: 9_999,
  })), { kind: 'timeout' });
});

test('current analysis waits for the whole requested sample window', () => {
  assert.deepEqual(decideBootProbeAnalysisReadiness(facts({
    reachedSamples: 1_199,
  })), { kind: 'wait' });
});

test('current analysis is ready once the window is complete before the deadline', () => {
  assert.deepEqual(decideBootProbeAnalysisReadiness(facts()), { kind: 'ready' });
});
