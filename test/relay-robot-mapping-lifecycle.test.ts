import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { BootProbeRuntime } from '../src/boot-probe-runtime.js';
import { decideCalibrationApplicability } from '../src/calibration-applicability.js';
import { decideCalibrationMixerApplication } from '../src/calibration-mixer-application.js';
import { CalibrationSession, type CalibrationContext, type ConfirmedCalibrationResult } from '../src/calibration-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';
import { createRelayRobotMappingOrchestration } from '../src/relay-robot-mapping-orchestration.js';
import type { RobotContentTransitionRuntime } from '../src/robot-content-transition-runtime.js';
import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';
import { RobotPlayerOffsetTracker } from '../src/robot-player-offset.js';
import { SourceRuntime } from '../src/source-runtime.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';
import { TimingRuntime } from '../src/timing-runtime.js';
import type { TimingWindow } from '../src/timing-window-collector.js';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

type BeginInput = Parameters<RobotContentTransitionRuntime['begin']>[0];
type ReconcileInput = Parameters<RobotContentTransitionRuntime['reconcileWithFreshDelta']>[0];
type BackingInput = Parameters<RobotContentTransitionRuntime['noteBackingFrame']>[0];
type BoundaryMessage = { type: 'backing-sample-boundary-request'; requestId: number };

function fixture() {
  const calls: string[] = [];
  const context: CalibrationContext = {
    sessionGeneration: 1, micGeneration: 2, backingGeneration: 3,
    micSourceRate: 48_000, backingSourceRate: 44_100, sourceGeneration: 4,
  };
  const state = {
    collecting: false, rateMatches: true, pendingBoundary: true, reconcile: true,
    appliedKind: 'content' as ReturnType<TimingRuntime['appliedCalibrationKind']>,
    stale: false, confirmed: { micLagMs: 25, confidence: 0.9, segmentLagsMs: [25] } as ConfirmedCalibrationResult | null,
    playbackRate: 1.25, committed: 125 as number | null, fresh: 250 as number | null,
    reference: 100 as number | null, robot: true,
    socket: { readyState: 1 } as { readyState: number } | null,
    backingGeneration: 3 as number | null, backingTotal: 1234,
    backingRate: 44_100 as number | null,
    request: { requestId: 77, backingGeneration: 3 } as { requestId: number; backingGeneration: number } | null,
    beginInput: null as BeginInput | null, reconcileInput: null as ReconcileInput | null,
    backingInput: null as BackingInput | null,
    sent: [] as Array<{ target: { readyState: number }; message: BoundaryMessage }>,
    throwAt: null as string | null,
  };
  const note = (label: string) => {
    calls.push(label);
    if (state.throwAt === label) throw new Error(label);
  };
  const deps = {
    mixSampleRate: 48_000, transitionHistorySamples: 144_000, maxCaptureGapMs: 300,
    socketOpenState: 1,
    offset: { reset() { note('offset.reset'); },
      offsetMs(_nowMs: number): number | null { return null; }, isFresh(_nowMs: number) { return false; } },
    timeline: {
      noteBackingBoundary(_boundary: number, _context: CalibrationContext, _nowMs: number): boolean {
        throw new Error('lifecycle tests must not commit evidence');
      },
      isReady(_context: CalibrationContext, _nowMs: number) { return true; },
      mapBackingStart(start: number, _context: CalibrationContext, _nowMs: number): number | null { return start; },
      reset() { note('timeline.reset'); },
      matchesPlaybackRate(rate: number) { note(`timeline.rate:${rate}`); return state.rateMatches; },
      get committedDeltaMs() { note('timeline.committed'); return state.committed; },
      get currentDeltaMs() { note('timeline.fresh'); return state.fresh; },
      get referenceDeltaMs() { note('timeline.reference'); return state.reference; },
      needsBackingBoundary(actual: CalibrationContext) {
        assert.equal(actual, context); note('timeline.boundary'); return state.pendingBoundary;
      },
    },
    source: { connected() { return true; }, invalidateMapping() { note('source.invalidate'); },
      isActive(): boolean { throw new Error('mapping lifecycle must not query source identity'); },
      detachRobot(): void { throw new Error('mapping lifecycle must not detach source'); } },
    calibration: {
      reset(): void { throw new Error('mapping lifecycle must not reset source calibration'); },
      restartWorkingEvidence(_nowMs: number): ReturnType<CalibrationSession['restartWorkingEvidence']> {
        throw new Error('lifecycle tests must not restart commit evidence');
      },
      get confirmedResult() { note('calibration.confirmed'); return state.confirmed; },
      get collecting() { note('calibration.collecting'); return state.collecting; },
      discardPrimedContent() { note('calibration.discard'); },
      fail(reason: string) { note(`calibration.fail:${reason}`); },
      transitionEvidence(_history: number): TimingWindow | null { return null; },
    },
    validator: {
      get collecting(): boolean { throw new Error('lifecycle tests must not query commit validation'); },
      cancel(_nowMs?: number): never { throw new Error('lifecycle tests must not cancel commit validation'); },
    },
    transition: {
      clear() { note('transition.clear'); },
      begin(input: BeginInput, nowMs?: number) {
        assert.equal(input.context, context); state.beginInput = input; note(`transition.begin:${nowMs}`);
      },
      reconcileWithFreshDelta(input: ReconcileInput, nowMs?: number) {
        assert.equal(input.context, context); state.reconcileInput = input;
        note(`transition.reconcile:${nowMs}`); return state.reconcile;
      },
      noteBackingFrame(input: BackingInput, nowMs?: number) {
        state.backingInput = input; note(`transition.backing:${nowMs}`); return false;
      },
      requestBackingBoundary(generation: number) {
        note(`transition.request:${generation}`); return state.request;
      },
    },
    backing: {
      get isRobot() { note('backing.robot'); return state.robot; },
      get socket() { note('backing.socket'); return state.socket; },
      get sampleRate() { note('backing.rate'); return state.backingRate; },
    },
    mix: {
      get active(): boolean { throw new Error('mapping lifecycle must not query active mix'); },
      get backingGeneration() { note('mix.backingGeneration'); return state.backingGeneration; },
      get backingTotalSamples() { note('mix.backingTotal'); return state.backingTotal; },
    },
    timing: { calibrationKind: 'content' as ReturnType<TimingRuntime['appliedCalibrationKind']>,
      clearCalibrationKind(): void { throw new Error('mapping lifecycle must not clear candidate kind'); },
      resetAutoCalibrationSchedule(): void { throw new Error('mapping lifecycle must not reset schedule'); } },
    take: { noteQualityEvent(): never { throw new Error('mapping lifecycle must not report source quality'); } },
    commands: { abandonProbeRun(): never { throw new Error('mapping lifecycle must not abandon source probe'); } },
    queries: {
      bootProbeSettled(): never { throw new Error('mapping lifecycle must not query source bootstrap'); },
      context() { note('context'); return context; },
      appliedKind() { note('timing.applied'); return state.appliedKind; },
      calibrationIsStale() { note('calibration.stale'); return state.stale; },
      currentPlaybackRate(nowMs: number) { note(`playback.rate:${nowMs}`); return state.playbackRate; },
    },
    effects: {
      notifyPreviousReplaced(): never { throw new Error('mapping lifecycle must not notify replaced source'); },
      feedBackingEvidence(_samples: Int16Array, _start: number, _nowMs: number) {
        throw new Error('lifecycle tests must not feed commit evidence');
      },
      clearContentValidation() { note('validation.clear'); },
      syncAppliedCalibration() { note('alignment.sync'); },
      reportSourceStatus() { note('publish.source'); },
      reportTimingStatus() { note('publish.timing'); },
      sendBoundaryRequest(target: { readyState: number }, message: BoundaryMessage) {
        assert.equal(target, state.socket); state.sent.push({ target, message });
        note(`boundary.send:${message.requestId}`);
      },
    },
  };
  return { calls, context, state, deps };
}

function lifecycle(f: ReturnType<typeof fixture>) {
  return createRelayRobotMappingOrchestration(f.deps);
}

function revokeTrace(reason: string, collecting: boolean) {
  return ['offset.reset', 'timeline.reset', 'transition.clear', 'source.invalidate',
    'calibration.discard', 'validation.clear', 'calibration.collecting',
    ...(collecting ? [`calibration.fail:${reason}`] : []),
    'alignment.sync', 'publish.source', 'publish.timing'];
}

for (const collecting of [false, true]) {
  test(`whole revocation preserves the complete transaction: collecting=${collecting}`, () => {
    const f = fixture(); f.state.collecting = collecting;
    assert.equal(lifecycle(f).revoke('mapping retired'), undefined);
    assert.deepEqual(f.calls, revokeTrace('mapping retired', collecting));
  });
}
test('whole-transition clear is distinct from request-only cancellation', () => {
  const f = fixture(); assert.equal(lifecycle(f).clearTransition(), undefined);
  assert.deepEqual(f.calls, ['transition.clear']);
});
for (const throwAt of ['offset.reset', 'source.invalidate', 'validation.clear', 'alignment.sync', 'publish.source']) {
  test(`revocation keeps synchronous exception cutoff at ${throwAt}`, () => {
    const f = fixture(); f.state.collecting = true; f.state.throwAt = throwAt;
    assert.throws(() => lifecycle(f).revoke('retired'), { message: throwAt });
    const trace = revokeTrace('retired', true);
    assert.deepEqual(f.calls, trace.slice(0, trace.indexOf(throwAt) + 1));
  });
}
for (const rate of [undefined, null, NaN, Infinity, -Infinity, 0, -1, '', 'not a rate']) {
  test(`invalid rate ${String(rate)} does not query or revoke the mapper`, () => {
    const f = fixture(); assert.equal(lifecycle(f).revokeOnRateChange(rate), false);
    assert.deepEqual(f.calls, []);
  });
}
test('same numeric rate is only a mapper query, including numeric strings', () => {
  const f = fixture(); assert.equal(lifecycle(f).revokeOnRateChange('1.25'), false);
  assert.deepEqual(f.calls, ['timeline.rate:1.25']);
});
test('a changed rate uses the one revocation transaction and exact original reason', () => {
  const f = fixture(); f.state.rateMatches = false; f.state.collecting = true;
  assert.equal(lifecycle(f).revokeOnRateChange(2), true);
  assert.deepEqual(f.calls, ['timeline.rate:2', ...revokeTrace(
    'The room changed playback rate during calibration.'
      + ' Rebuilding the Robot content mapping before calibration retries.', true,
  )]);
});

for (const entry of ['begin', 'reconcile'] as const) {
  for (const [label, appliedKind, stale, confirmed, expected, authorityTrace] of [
    ['confirmed content', 'content', false, true, 25, ['timing.applied', 'calibration.stale', 'calibration.confirmed']],
    ['retained boot', 'boot-probe', false, true, null, ['timing.applied']],
    ['no authority', 'none', false, true, null, ['timing.applied']],
    ['stale content', 'content', true, true, null, ['timing.applied', 'calibration.stale']],
    ['no confirmed content', 'content', false, false, null, ['timing.applied', 'calibration.stale', 'calibration.confirmed']],
  ] as const) {
    test(`${entry} passes only valid applied content as its reference: ${label}`, () => {
      const f = fixture(); f.state.appliedKind = appliedKind; f.state.stale = stale;
      if (!confirmed) f.state.confirmed = null;
      if (entry === 'begin') {
        assert.equal(lifecycle(f).beginTransition(3.5, 4.25, 125, 100, f.context, 50), undefined);
        assert.deepEqual(f.state.beginInput, { fromMediaTime: 3.5, toMediaTime: 4.25,
          preDeltaMs: 125, referenceDeltaMs: 100, context: f.context,
          confirmedReferenceLagMs: expected, playbackRate: 1.25 });
        assert.deepEqual(f.calls, [...authorityTrace, 'playback.rate:50', 'transition.begin:50']);
      } else {
        assert.equal(lifecycle(f).reconcile(f.context, 50), true);
        assert.deepEqual(f.state.reconcileInput, { context: f.context, committedDeltaMs: 125,
          freshDeltaMs: 250, referenceDeltaMs: 100, confirmedReferenceLagMs: expected, playbackRate: 1.25 });
        assert.deepEqual(f.calls, [...authorityTrace, 'timeline.committed', 'timeline.fresh',
          'timeline.reference', 'playback.rate:50', 'transition.reconcile:50']);
      }
    });
  }
}
test('reconcile preserves null deltas and the transition rejection', () => {
  const f = fixture(); f.state.committed = null; f.state.fresh = null;
  f.state.reference = null; f.state.reconcile = false;
  assert.equal(lifecycle(f).reconcile(f.context, 60), false);
  assert.deepEqual(f.state.reconcileInput, { context: f.context, committedDeltaMs: null,
    freshDeltaMs: null, referenceDeltaMs: null, confirmedReferenceLagMs: 25, playbackRate: 1.25 });
});
for (const generation of [3, null]) {
  test(`backing frame preserves metadata/samples identity/floor and leaves admission to runtime: generation=${generation}`, () => {
    const f = fixture(); const pcm = Buffer.alloc(7); const samples = new Int16Array([5, 6]);
    const frame: PcmFrame = { generation, firstSampleIndex: generation === null ? null : 900, pcm };
    assert.equal(lifecycle(f).noteBackingFrame(frame, samples, -123.5, 70), undefined);
    assert.deepEqual(f.state.backingInput, { frameGeneration: generation, firstSampleIndex: frame.firstSampleIndex,
      sourceSampleCount: 3, sourceSampleRate: 44_100, samples, start: -123.5, backingTotalSamples: 1234 });
    assert.equal(f.state.backingInput?.samples, samples);
    assert.deepEqual(f.calls, ['backing.rate', 'mix.backingTotal', 'transition.backing:70']);
  });
}

const reconcileTrace = ['timing.applied', 'calibration.stale', 'calibration.confirmed',
  'timeline.committed', 'timeline.fresh', 'timeline.reference', 'playback.rate:80', 'transition.reconcile:80'];
const requestReadyTrace = ['context', 'timeline.boundary', ...reconcileTrace,
  'backing.socket', 'mix.backingGeneration', 'backing.robot'];
test('no pending boundary performs no reconciliation, transport sampling or send', () => {
  const f = fixture(); f.state.pendingBoundary = false;
  assert.equal(lifecycle(f).requestBoundary(80), false);
  assert.deepEqual(f.calls, ['context', 'timeline.boundary']);
});
test('a rejected reconciliation performs no transport sampling or send', () => {
  const f = fixture(); f.state.reconcile = false;
  assert.equal(lifecycle(f).requestBoundary(80), false);
  assert.deepEqual(f.calls, ['context', 'timeline.boundary', ...reconcileTrace]);
});
for (const guard of ['not Robot', 'no socket', 'closed socket', 'no backing generation', 'no request'] as const) {
  test(`boundary request fails closed at ${guard} without sending`, () => {
    const f = fixture();
    if (guard === 'not Robot') f.state.robot = false;
    if (guard === 'no socket') f.state.socket = null;
    if (guard === 'closed socket') f.state.socket = { readyState: 3 };
    if (guard === 'no backing generation') f.state.backingGeneration = null;
    if (guard === 'no request') f.state.request = null;
    assert.equal(lifecycle(f).requestBoundary(80), false);
    assert.deepEqual(f.calls, guard === 'no request' ? [...requestReadyTrace, 'transition.request:3'] : requestReadyTrace);
    assert.deepEqual(f.state.sent, []);
  });
}
test('boundary request reconciles before socket/generation sampling and sends the exact wire message', () => {
  const f = fixture(); assert.equal(lifecycle(f).requestBoundary(80), true);
  assert.deepEqual(f.calls, [...requestReadyTrace, 'transition.request:3', 'boundary.send:77']);
  assert.deepEqual(f.state.sent, [{ target: f.state.socket,
    message: { type: 'backing-sample-boundary-request', requestId: 77 } }]);
});
test('request send errors remain synchronous after the request has already been admitted', () => {
  const f = fixture(); f.state.throwAt = 'boundary.send:77';
  assert.throws(() => lifecycle(f).requestBoundary(80), { message: 'boundary.send:77' });
  assert.deepEqual(f.calls, [...requestReadyTrace, 'transition.request:3', 'boundary.send:77']);
});

function analysis(lag: number): TimingCalibrationAnalysis {
  return { micLagMs: lag, confidence: 0.8, segmentLagsMs: [lag, lag, lag],
    segmentCorrelations: [0.9, 0.9, 0.9], micLevelDbfs: -20, backingLevelDbfs: -12 };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

// This fixture crosses the actual generation, measurement, applicability and
// alignment owners. Only analyzer completion and external publications are
// controlled ports. It is not a claim about a physical acoustic route.
function measuredFixture() {
  const f = fixture();
  const source = new SourceRuntime<{ isRobotSource?: boolean }>({ isConnected: () => true });
  source.attachRobot({});
  const mix = new AudioSession({ sampleRate: 48_000, frameMs: 20,
    prebufferMs: 0, backingGain: 1, retentionMs: 5_000 });
  mix.start(0);
  mix.ingestMic({ generation: 2, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, 48_000, 0);
  mix.ingestBacking({ generation: 3, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, 44_100, 0);
  const context = (): CalibrationContext => ({
    sessionGeneration: mix.generation, micGeneration: mix.micGeneration,
    backingGeneration: mix.backingGeneration, micSourceRate: 48_000,
    backingSourceRate: 44_100, sourceGeneration: source.generation,
  });
  const offset = new RobotPlayerOffsetTracker({ freshForMs: 2_000, windowMs: 3_000 });
  const timeline = new RobotContentTimelineMapper({ sampleRate: 48_000, freshForMs: 2_000 });
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 1_000 });
  const boot = new BootProbeRuntime({ maxAttempts: 1, retryMs: 100 });
  boot.recordCalibration(context(), { advanceMs: 150, micLatencyMs: 200,
    backingLatencyMs: 75, deltaMs: 25, confidence: 0.9 });
  const control = { deferred: false, lag: 240, settled: 0 };
  const pending: Array<{
    signal: AbortSignal | undefined;
    resolve(value: TimingCalibrationAnalysis): void;
    reject(error: unknown): void;
  }> = [];
  const calibration = new CalibrationSession({
    sampleRate: 48_000, durationMs: 6_000, timeoutMs: 20_000,
    agreementWindows: 1, now: () => 0, context,
    analyze: (_mic, _backing, _rate, _maxLag, signal) => {
      if (!control.deferred) return analysis(control.lag);
      return new Promise<TimingCalibrationAnalysis>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      });
    },
    onSettled: () => {
      control.settled += 1;
      timing.syncConfirmedAuthority({ confirmedRevision: calibration.confirmedRevision,
        hasConfirmedResult: calibration.confirmedResult !== null });
      // Preserve the actual server settlement's nested publication order; the
      // coordinator still performs its own later synchronization/publications.
      f.deps.effects.syncAppliedCalibration();
      f.deps.effects.reportTimingStatus();
      f.deps.effects.reportSourceStatus();
    },
  });
  const appliedKind = () => timing.appliedCalibrationKind({
    hasConfirmedResult: calibration.confirmedResult !== null,
    provisional: calibration.status().provisional,
  });
  function syncAlignment() {
    f.calls.push('alignment.sync');
    const kind = appliedKind();
    assert.notEqual(kind, 'boot-probe', 'this composition tests content alignment only');
    const result = calibration.result;
    const applicability = decideCalibrationApplicability({
      kind, hasResult: result !== null, stale: result !== null && calibration.isStaleFor(context()),
      calibrationTransactionActive: calibration.transactionActive,
      calibrationProvisional: calibration.status().provisional,
      hasConfirmedResult: calibration.confirmedResult !== null,
      robotProbeTimingActive: false, bootProbeSettled: true, robotRouteActive: true,
      robotSourceConnected: source.connected(), roomHasSong: true,
      robotDeltaFresh: offset.offsetMs(0) !== null && offset.isFresh(0),
      robotDeltaEverEstablished: Number.isFinite(offset.lastReportedAtMs),
      robotContentMappingReady: timeline.isReady(context(), 0),
    });
    const next = applicability === 'apply' ? timeline.liveLagMs(result!.micLagMs, context(), 0) : null;
    const decision = decideCalibrationMixerApplication({
      applicability, calibrationKind: kind, activeMicLagMs: mix.alignment.calibratedMicLagMs,
      nextMicLagMs: next, robotContentAuthority: kind === 'content',
      hasContentValidationSlew: timing.contentValidationSlewRevision !== null,
      contentValidationSlewMatchesRevision: timing.contentValidationSlewMatches(calibration.confirmedRevision),
      calibratedMicLagTarget: mix.calibratedMicLagTarget, jitterThresholdMs: 20,
    });
    if (decision.clearContentValidationSlew) timing.clearContentValidationSlew();
    if (decision.kind === 'set') mix.setAlignment({ calibratedMicLagMs: decision.micLagMs });
    if (decision.kind === 'slew') mix.slewCalibratedMicLagTo(decision.micLagMs);
  }
  f.deps.offset = offset;
  f.deps.timeline = timeline;
  f.deps.source = { connected: () => source.connected(),
    isActive: f.deps.source.isActive, detachRobot: f.deps.source.detachRobot,
    invalidateMapping() { f.calls.push('source.invalidate'); source.invalidateMapping(); } };
  f.deps.calibration = calibration;
  f.deps.mix = mix;
  f.deps.timing = timing;
  f.deps.queries.context = context;
  f.deps.queries.appliedKind = appliedKind;
  f.deps.queries.calibrationIsStale = () => calibration.isStaleFor(context());
  f.deps.queries.currentPlaybackRate = () => 1;
  f.deps.effects.clearContentValidation = () => timing.clearContentValidationBaseline();
  f.deps.effects.syncAppliedCalibration = syncAlignment;
  function refreshMapping() {
    offset.record(25, 0);
    timeline.notePlayerOffset(25, context(), 0, 1);
  }
  function collect() {
    timing.beginContentCalibration(0, false);
    calibration.start(0);
    const pcm = new Int16Array(288_000);
    calibration.observeMic(pcm, 0);
    calibration.observeBacking(pcm, 0);
  }
  refreshMapping();
  return { f, source, mix, context, offset, timeline, timing, boot, calibration,
    control, pending, refreshMapping, collect, syncAlignment, owner: lifecycle(f) };
}

for (const refresh of [false, true]) {
  test(`revocation fences a deferred real calibration with no previous authority: fresh mapping=${refresh}`, async () => {
    const h = measuredFixture(); h.control.deferred = true; h.collect();
    assert.equal(h.pending.length, 1); assert.equal(h.pending[0].signal?.aborted, false);
    const generation = h.source.generation;
    const bootResult = h.boot.calibrationResult;
    h.owner.revoke('old mapping retired');
    assert.equal(h.source.generation, generation + 1);
    assert.equal(h.pending[0].signal?.aborted, true);
    assert.equal(h.calibration.status().state, 'failed');
    assert.equal(h.calibration.status().error, 'old mapping retired');
    assert.equal(h.calibration.confirmedRevision, 0);
    assert.equal(h.mix.alignment.calibratedMicLagMs, null);
    assert.deepEqual(h.boot.calibrationResult, bootResult);
    assert.equal(h.boot.pathDifferenceMs, 125);
    assert.equal(h.boot.completedContextMatches(h.context()), true);
    if (refresh) {
      h.refreshMapping(); h.syncAlignment();
      assert.equal(h.timeline.isReady(h.context(), 0), true);
    }
    const settled = h.control.settled; const calls = [...h.f.calls];
    h.pending[0].resolve(analysis(999)); await nextTurn();
    assert.equal(h.calibration.confirmedRevision, 0);
    assert.equal(h.calibration.confirmedResult, null);
    assert.equal(h.mix.alignment.calibratedMicLagMs, null);
    assert.equal(h.control.settled, settled);
    assert.deepEqual(h.f.calls, calls, 'late answer must not settle/publish/reapply');
  });
}
test('revocation retains historical confirmed content but fresh telemetry cannot resurrect its alignment', async () => {
  const h = measuredFixture(); h.collect();
  assert.equal(h.calibration.confirmedRevision, 1);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
  h.control.deferred = true; h.collect();
  h.owner.revoke('retired reference');
  assert.equal(h.calibration.confirmedRevision, 1);
  assert.equal(h.calibration.confirmedResult?.micLagMs, 240);
  assert.equal(h.calibration.isStaleFor(h.context()), true);
  assert.equal(h.mix.alignment.calibratedMicLagMs, null);
  assert.deepEqual(h.f.calls.slice(-6), ['alignment.sync', 'publish.timing',
    'publish.source', 'alignment.sync', 'publish.source', 'publish.timing'],
  'calibration settlement publishes inside fail before the coordinator publishes again');
  h.refreshMapping(); h.syncAlignment();
  assert.equal(h.mix.alignment.calibratedMicLagMs, null);
  const settled = h.control.settled; const calls = [...h.f.calls];
  h.pending[0].resolve(analysis(999)); await nextTurn();
  assert.equal(h.calibration.confirmedRevision, 1);
  assert.equal(h.calibration.confirmedResult?.micLagMs, 240);
  assert.equal(h.mix.alignment.calibratedMicLagMs, null);
  assert.equal(h.control.settled, settled); assert.deepEqual(h.f.calls, calls);
});
test('an old answer cannot complete a successor run, but the new context can promote normally', async () => {
  const h = measuredFixture(); h.collect(); h.control.deferred = true; h.collect();
  h.owner.revoke('new reference'); h.refreshMapping(); h.collect();
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[0].signal?.aborted, true);
  assert.equal(h.pending[1].signal?.aborted, false);
  const settled = h.control.settled;
  h.pending[0].resolve(analysis(999)); await nextTurn();
  assert.equal(h.calibration.status().state, 'collecting');
  assert.equal(h.calibration.confirmedRevision, 1);
  assert.equal(h.mix.alignment.calibratedMicLagMs, null);
  assert.equal(h.control.settled, settled);
  h.pending[1].resolve(analysis(300)); await nextTurn();
  assert.equal(h.calibration.status().state, 'complete');
  assert.equal(h.calibration.confirmedRevision, 2);
  assert.equal(h.calibration.confirmedResult?.micLagMs, 300);
  assert.equal(h.calibration.isStaleFor(h.context()), false);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 300);
});
test('a late rejection from the retired worker cannot fail or republish a valid successor', async () => {
  const h = measuredFixture(); h.control.deferred = true; h.collect();
  h.owner.revoke('retired'); h.refreshMapping(); h.control.deferred = false; h.control.lag = 360; h.collect();
  assert.equal(h.calibration.confirmedRevision, 1);
  const settled = h.control.settled; const calls = [...h.f.calls];
  h.pending[0].reject(new Error('old worker failure')); await nextTurn();
  assert.equal(h.calibration.status().state, 'complete');
  assert.equal(h.calibration.status().error, null);
  assert.equal(h.calibration.confirmedRevision, 1);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 360);
  assert.equal(h.control.settled, settled); assert.deepEqual(h.f.calls, calls);
});
test('revocation discards primed old-context PCM and permits new-context evidence', () => {
  const h = measuredFixture(); const pcm = new Int16Array(96_000);
  h.calibration.primeMic(pcm, 0); h.calibration.primeBacking(pcm, 0);
  assert.equal(h.calibration.transitionEvidence(96_000)?.mic.length, 96_000);
  h.owner.revoke('primed reference retired');
  assert.equal(h.calibration.transitionEvidence(96_000), null);
  h.refreshMapping();
  h.calibration.primeMic(pcm, 0); h.calibration.primeBacking(pcm, 0);
  assert.equal(h.calibration.transitionEvidence(96_000)?.mic.length, 96_000);
  h.source.invalidateMapping();
  assert.equal(h.calibration.transitionEvidence(96_000), null, 'actual owner fences capture evidence by context');
});

test('lifecycle construction does not query or mutate any domain owner', () => {
  const f = fixture(); lifecycle(f);
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.sent.length, 0);
});

test('production binds lifecycle effects and canonical owners into the same unique mapping composition', () => {
  const text = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), text);
  const composition = variableInitializerCode(server, 'relayRobotMapping');
  for (const binding of ['socketOpenState: WebSocket.OPEN', 'offset: robotPlayerOffset',
    'timeline: robotContentTimeline', 'source: sourceRuntime', 'calibration,', 'backing: backingRuntime',
    'transition: robotContentTransitionRuntime', 'mix: session', 'currentPlaybackRate,',
    'clearContentValidation: clearContentValidationBaseline']) assert.ok(composition.includes(binding), binding);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(composition, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(composition, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(composition, /sendBoundaryRequest: \(target, message\) => sendJson\(target, message\)/);
  assert.equal((text.match(/const relayRobotMapping = /g) ?? []).length, 1);
  assert.doesNotMatch(text, /const robotContentMappingRevocationCoordinator\b|createRelayRobotMappingLifecycle\(/);
  assert.doesNotMatch(composition, /bootProbeRuntime|setInterval|setTimeout/);
});

test('all remaining lifecycle wrappers keep their default clock and contain delegation only', () => {
  const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
    readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
  for (const [name, expected, defaultClock] of [
    ['clearRobotContentTransition', 'relayRobotMapping.clearTransition();', false],
    ['revokeRobotContentMapping', 'relayRobotMapping.revoke(reason);', false],
    ['revokeContentMappingOnRateChange', 'return relayRobotMapping.revokeOnRateChange(playbackRate);', false],
    ['noteRobotTransitionBackingFrame', 'relayRobotMapping.noteBackingFrame(frame,samples,start,nowMs);', false],
    ['requestRobotBackingBoundary', 'return relayRobotMapping.requestBoundary(nowMs);', true],
  ] as const) {
    const code = functionCode(server, name);
    if (defaultClock) assert.ok(code.includes('nowMs = performance.now()'), `${name} default clock`);
    const body = code.replace(/^function\s+\w+\([\s\S]*?\)\s*\{/, '{')
      .replace(/,\s*\)/g, ')').replace(/\s+/g, '');
    assert.equal(body, `{${expected.replace(/\s+/g, '')}}`, name);
  }
  assert.doesNotMatch(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
    /function reconcileRobotContentTransitionWithFreshDelta\(/,
    'the old reconcile wrapper has no production callers after requestBoundary moves');
  const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(server.text, /function beginRobotContentTransition\(/,
    'the old begin wrapper has no production callers after source seek moves');
  const seek = variableInitializerCode(mapping, 'seek');
  assert.match(seek, /mapping\.beginTransition\(fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs\)/);
  assert.doesNotMatch(seek, /performance|Date\.now|queries\.context/,
    'the actual source seek caller passes the already-sampled clock and context unchanged');
  assert.match(functionCode(mapping, 'createRelayRobotMappingOrchestration'), /beginTransition: lifecycle\.beginTransition/);
  assert.match(functionCode(mapping, 'requestBoundary'), /reconcile\(context, nowMs\)/);
});
