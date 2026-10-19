import assert from 'node:assert/strict';
import test from 'node:test';

import { CalibrationCoordinator, type CalibrationCoordinatorHost } from '../src/calibration-coordinator.js';
import { ContentCalibrationCoordinator, type ContentCalibrationConfig } from '../src/content-calibration-coordinator.js';
import { TimingRuntime } from '../src/timing-runtime.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

function analysis(lag = 310): TimingCalibrationAnalysis {
  return { micLagMs: lag, confidence: 0.9, segmentLagsMs: [lag], segmentCorrelations: [0.9], micLevelDbfs: -20, backingLevelDbfs: -12 };
}

function pendingAnalysis() {
  let resolve!: (result: TimingCalibrationAnalysis) => void;
  let signal: AbortSignal | undefined;
  const promise = new Promise<TimingCalibrationAnalysis>((done) => { resolve = done; });
  return {
    analyze: (_mic: Int16Array, _backing: Int16Array, _rate: number, _lag?: number, received?: AbortSignal) => {
      signal = received;
      return promise;
    },
    resolve,
    get signal() { return signal; },
  };
}

function fixture(options: {
  analyze?: ContentCalibrationConfig['measurement']['analyze'];
  validate?: ContentCalibrationConfig['validation']['analyze'];
} = {}) {
  const context = { sessionGeneration: 1, micGeneration: 2, backingGeneration: 3, sourceGeneration: 4 };
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  const state = { backing: false, appliedLag: null as number | null, probeEvidence: true };
  const events: string[] = [];
  const sources: { lag: number | null; kind: string; collecting: boolean }[] = [];
  let content: ContentCalibrationCoordinator;
  const apply = () => {
    events.push('apply');
    state.appliedLag = content.measurement.isStaleFor(context) ? null : content.measurement.result?.micLagMs ?? null;
    return true;
  };
  const timingChanged = () => events.push('timing');
  const sourceChanged = () => {
    events.push('source');
    sources.push({ lag: state.appliedLag, kind: timing.calibrationKind, collecting: content.measurement.collecting });
  };
  content = new ContentCalibrationCoordinator({
    automatic: false,
    measurement: { sampleRate: 1_000, durationMs: 100, timeoutMs: 1_000, context: () => context, analyze: options.analyze ?? (() => analysis()) },
    validation: {
      sampleRate: 1_000, durationMs: 100, timeoutMs: 1_000, intervalMs: 100, retryMs: 50,
      deviationThresholdMs: 30, agreementToleranceMs: 25, analyze: options.validate ?? (() => analysis()),
    },
  }, {
    timing,
    authority: {
      kind: () => timing.appliedCalibrationKind({ hasConfirmedResult: content.measurement.confirmedResult !== null, provisional: content.measurement.status().provisional }),
      stale: () => content.measurement.isStaleFor(context),
      apply,
    },
    route: { robotActive: () => false, bootSettled: () => true, bootExhausted: () => false, evidenceMappingReady: () => true },
    media: {
      active: () => true, backingConnected: () => state.backing, micControlConnected: () => true,
      streamsFlowing: () => true, timeline: () => ({ connected: true, state: 1 }), noteMicMeasured: () => {},
    },
    takeBlocked: () => false, timingChanged, sourceChanged,
  });
  const host: CalibrationCoordinatorHost = {
    content, timing,
    probe: {
      clear: () => { events.push('probe-clear'); state.probeEvidence = false; },
      abandon: () => events.push('probe-abandon'),
      expireRequest: () => {}, finishAnalysis: () => {}, startIfReady: () => {}, restart: () => {},
    },
    route: { robotActive: () => false, bootSettled: () => true, sweepContentTransition: () => {} },
    alignment: { apply, reapplyBoot: () => {} },
    silentSides: () => [], timingChanged, sourceChanged,
  };
  const coordinator = new CalibrationCoordinator(1_500, host);
  function seed() {
    timing.beginContentCalibration(0, true);
    content.measurement.applyValidatedResult(analysis());
    events.length = 0; sources.length = 0;
  }
  function measure() {
    content.measurement.start(0);
    content.measurement.observeMic(new Int16Array(100), 0);
    content.measurement.observeBacking(new Int16Array(100), 0);
  }
  function validate() {
    content.validation.setBaseline({ micLagMs: 310, confidence: 0.9, segmentLagsMs: [310], context: { ...context } }, 0);
    content.validation.maybeStart(100);
    content.validation.observeMic(new Int16Array(100), 0);
    content.validation.observeBacking(new Int16Array(100), 0);
    events.length = 0; sources.length = 0;
  }
  return { coordinator, content, timing, context, state, events, sources, seed, measure, validate };
}

const invalidations = {
  'Mic replacement': (f: ReturnType<typeof fixture>) => f.coordinator.micCaptureReplaced(),
  'Mic restart': (f: ReturnType<typeof fixture>) => f.coordinator.captureRestarted('mic'),
  'Backing restart': (f: ReturnType<typeof fixture>) => f.coordinator.captureRestarted('backing'),
  'mapping revocation': (f: ReturnType<typeof fixture>) => f.coordinator.mappingRevoked('reference retired'),
  'owner invalidation': (f: ReturnType<typeof fixture>) => f.coordinator.invalidateTiming('owner changed'),
  'Robot replacement': (f: ReturnType<typeof fixture>) => f.coordinator.robotSourceActivated(true, 101),
  'Robot disconnect': (f: ReturnType<typeof fixture>) => f.coordinator.robotSourceDisconnected(),
  'session stop': (f: ReturnType<typeof fixture>) => f.coordinator.reset(),
};

for (const [name, invalidate] of Object.entries(invalidations)) {
  test(`${name} cancels pending measurement immediately, including without a live backing`, async () => {
    const pending = pendingAnalysis();
    const f = fixture({ analyze: pending.analyze });
    f.seed();
    f.measure();
    assert.equal(pending.signal?.aborted, false);
    const revision = f.content.measurement.confirmedRevision;
    f.context.micGeneration++;
    invalidate(f);
    assert.equal(pending.signal?.aborted, true);
    assert.equal(f.content.measurement.collecting, false);
    pending.resolve(analysis(610));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.content.measurement.confirmedRevision, revision);
    if (name !== 'session stop') assert.equal(f.content.measurement.confirmedResult?.micLagMs, 310);
  });

  test(`${name} retires pending independent drift validation`, async () => {
    const pending = pendingAnalysis();
    const f = fixture({ validate: pending.analyze });
    f.seed();
    f.validate();
    assert.equal(pending.signal?.aborted, false);
    const revision = f.content.measurement.confirmedRevision;
    invalidate(f);
    assert.equal(pending.signal?.aborted, true);
    assert.equal(f.content.validation.hasBaseline, false);
    pending.resolve(analysis(610));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.content.measurement.confirmedRevision, revision);
  });
}

test('capture replacement retains confirmed history and retry metadata, with stale timing published first', () => {
  const f = fixture();
  f.seed();
  f.context.micGeneration++;
  f.coordinator.micCaptureReplaced();
  assert.equal(f.state.probeEvidence, false);
  assert.equal(f.content.measurement.confirmedResult?.micLagMs, 310);
  assert.equal(f.content.measurement.isStaleFor(f.context), true);
  assert.equal(f.timing.calibrationKind, 'content');
  assert.equal(f.timing.autoCalibrationDue(50), false);
  assert.deepEqual(f.events, ['probe-clear', 'timing', 'apply', 'timing', 'source']);
  assert.deepEqual(f.sources, [{ lag: null, kind: 'content', collecting: false }]);
});

for (const side of ['mic', 'backing'] as const) {
  test(`${side} capture restart publishes its failed collection once through settlement`, () => {
    const f = fixture();
    f.seed();
    f.content.measurement.start(0);
    f.context.micGeneration++;
    f.coordinator.captureRestarted(side);
    assert.equal(f.events.filter((event) => event === 'source').length, 1);
    assert.deepEqual(f.events.slice(-3), ['apply', 'timing', 'source']);
    assert.equal(f.state.probeEvidence, true);
    assert.match(f.content.measurement.status().error!, /capture restarted during calibration/);
  });
}

test('idle owner invalidation clears confirmation and strategy and resets automatic retry', () => {
  const f = fixture();
  f.seed();
  f.coordinator.invalidateTiming('owner changed');
  assert.equal(f.content.measurement.confirmedResult, null);
  assert.equal(f.timing.calibrationKind, 'none');
  assert.equal(f.timing.autoCalibrationDue(50), true);
  assert.deepEqual(f.events, ['probe-clear', 'timing', 'apply', 'timing', 'source']);
});

test('mapping revocation retains pipeline evidence and publishes the withdrawn alignment before timing', () => {
  const f = fixture();
  f.seed();
  f.context.sourceGeneration++;
  f.coordinator.mappingRevoked('seek retired the reference');
  assert.equal(f.state.probeEvidence, true);
  assert.deepEqual(f.events, ['timing', 'apply', 'source', 'timing']);
  assert.equal(f.state.appliedLag, null);
  assert.equal(f.content.measurement.confirmedResult?.micLagMs, 310);
});

test('ordinary Robot activation keeps a content run belonging to the current reference', () => {
  const f = fixture();
  f.seed();
  f.content.measurement.start(0);
  f.coordinator.robotSourceActivated(false, 10);
  assert.equal(f.content.measurement.collecting, true);
  assert.equal(f.events.includes('probe-abandon'), false);
  assert.deepEqual(f.events, ['apply', 'source', 'timing']);
});

test('media interruption cancels analysis but preserves the independent validator baseline for a retry', async () => {
  const pending = pendingAnalysis();
  const f = fixture({ validate: pending.analyze });
  f.seed();
  f.validate();
  f.coordinator.interruptContent('backing disconnected', 101);
  assert.equal(pending.signal?.aborted, true);
  assert.equal(f.content.validation.hasBaseline, true);
  assert.equal(f.content.validation.collecting, false);
  assert.equal(f.state.probeEvidence, true);
  assert.deepEqual(f.events, ['timing']);
  pending.resolve(analysis(610));
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.content.measurement.confirmedResult?.micLagMs, 310);
});

test('stopping the session clears all timing strategies and opens a fresh automatic retry schedule', () => {
  const f = fixture();
  f.seed();
  f.validate();
  f.coordinator.reset();
  assert.equal(f.state.probeEvidence, false);
  assert.equal(f.content.validation.hasBaseline, false);
  assert.equal(f.content.measurement.confirmedResult, null);
  assert.equal(f.timing.calibrationKind, 'none');
  assert.equal(f.timing.autoCalibrationDue(50), true);
  assert.equal(f.events.includes('source'), false, 'the physical session stop owns the complete status publication');
});
