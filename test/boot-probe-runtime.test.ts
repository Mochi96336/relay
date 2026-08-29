import assert from 'node:assert/strict';
import test from 'node:test';

import { BootProbeRuntime, type BootProbeContext } from '../src/boot-probe-runtime.js';

const context: BootProbeContext = {
  sessionGeneration: 10,
  micGeneration: 20,
  backingGeneration: 30,
};

function runtime() {
  return new BootProbeRuntime({ maxAttempts: 2, retryMs: 100 });
}

test('BootProbeRuntime keeps request state and measured Mic evidence in one reset domain', () => {
  const probe = runtime();
  const firstId = probe.nextRequestId();
  assert.equal(firstId, 1);
  assert.equal(probe.beginRequest({
    target: 'mic',
    requestId: firstId,
    serverSentAtMs: 100,
    sessionGeneration: context.sessionGeneration,
    generation: context.micGeneration,
  }), true);
  assert.equal(probe.status(100).phase, 'mic-requested');

  const accepted = probe.acceptClientReply(firstId, context.micGeneration);
  assert.ok(accepted);
  assert.equal(probe.beginAnalysis({
    target: 'mic',
    targetSample: 1_000,
    windowStart: 800,
    windowSamples: 400,
    sessionGeneration: context.sessionGeneration,
    generation: context.micGeneration,
    deadlineMs: 1_000,
  }), true);
  assert.equal(probe.takeAnalysis()?.target, 'mic');

  probe.noteCorrelation('mic', 0.91);
  probe.setMicLeg({
    targetSample: 1_000,
    actualSample: 1_120,
    correlation: 0.91,
    sessionGeneration: context.sessionGeneration,
    micGeneration: context.micGeneration,
  });
  assert.equal(probe.status(200).phase, 'backing-waiting');
  assert.equal(probe.micLegMatches(context), true);

  probe.abandonRun();
  assert.equal(probe.micLeg, null);
  assert.equal(probe.pendingRequest, null);
  assert.equal(probe.pendingAnalysis, null);
  assert.deepEqual(probe.correlations, { mic: 0.91, backing: null }, 'run abandonment preserves diagnostics');
  assert.equal(probe.nextRequestId(), 2, 'request ids remain monotonic across abandoned runs');
});

test('Mic failure clears only provisional Mic evidence while retaining bounded retry state', () => {
  const probe = runtime();
  const requestId = probe.nextRequestId();
  assert.equal(probe.beginRequest({
    target: 'mic',
    requestId,
    serverSentAtMs: 400,
    sessionGeneration: context.sessionGeneration,
    generation: context.micGeneration,
  }), true);
  probe.setMicLeg({
    targetSample: 1_000,
    actualSample: 1_050,
    correlation: 0.8,
    sessionGeneration: context.sessionGeneration,
    micGeneration: context.micGeneration,
  });
  const failure = probe.failAttempt('mic', 'synthetic failure', 500);
  assert.equal(failure, null);
  assert.equal(probe.micLeg, null);
  assert.equal(probe.status(500).phase, 'mic-retry-wait');
  assert.equal(probe.canStart('mic', 599), false);
  assert.equal(probe.canStart('mic', 600), true);
});

test('completed boot evidence survives candidate reruns and can be re-applied against a new delta', () => {
  const probe = runtime();
  const result = {
    advanceMs: 420,
    micLatencyMs: 650,
    backingLatencyMs: 300,
    deltaMs: 70,
    confidence: 0.82,
  };

  probe.noteCorrelation('mic', 0.9);
  probe.noteCorrelation('backing', 0.82);
  probe.recordCalibration(context, result);

  assert.equal(probe.completedContextMatches(context), true);
  assert.equal(probe.completedContextMatches({ ...context, backingGeneration: 31 }), false);
  assert.equal(probe.pathDifferenceMs, 350);
  assert.equal(probe.confidence, 0.82);
  assert.deepEqual(probe.calibrationResult, result);

  probe.abandonRun();
  probe.resetCorrelations();
  assert.deepEqual(probe.calibrationResult, result, 'candidate rerun keeps the previous confirmed result authoritative');
  assert.deepEqual(probe.correlations, { mic: null, backing: null });

  const reapplied = probe.reapplyCalibration(500, 150);
  assert.equal(reapplied?.advanceMs, 500);
  assert.equal(reapplied?.deltaMs, 150);
  assert.equal(probe.pathDifferenceMs, 350, 'delta reapply does not rewrite measured path difference');
  assert.equal(probe.confidence, 0.82);

  probe.clear();
  assert.equal(probe.calibrationResult, null);
  assert.equal(probe.pathDifferenceMs, null);
  assert.equal(probe.confidence, null);
  assert.equal(probe.completedContextMatches(context), false);
  assert.deepEqual(probe.correlations, { mic: null, backing: null });
});