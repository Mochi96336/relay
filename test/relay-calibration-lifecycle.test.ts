import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { BootProbeRuntime, type BootProbeContext } from '../src/boot-probe-runtime.js';
import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import { ContentCalibrationValidator } from '../src/content-calibration-validator.js';
import { createRelayCalibrationOrchestration, createRelayContentCalibrationOrchestration,
  createRelayCalibrationLifecycle, type RelayCalibrationLifecycleDependencies } from '../src/relay-calibration-orchestration.js';
import { createRelayBootProbeOrchestration } from '../src/relay-boot-probe-orchestration.js';
import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';
import { RobotPlayerOffsetTracker } from '../src/robot-player-offset.js';
import { SourceRuntime } from '../src/source-runtime.js';
import { TimingRuntime } from '../src/timing-runtime.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

import { functionCode, hasFunction, importSources, objectArrowCallbackCode, parseTypeScriptSource,
  sourceCode, variableInitializerCode } from './support/source-contract.js';

const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));

test('production lifecycle binds one canonical instance before async start without reading later Boot workflow', () => {
  const construction = variableInitializerCode(server, 'relayCalibrationLifecycle');
  assert.equal(construction.replace(/\s/g, ''), `createRelayCalibrationLifecycle({
    mix: session, calibration, timing: timingRuntime, probe: bootProbeRuntime, backing: backingRuntime,
    offset: robotPlayerOffset, contentTimeline: robotContentTimeline,
    commands: { clearContentValidation: clearContentValidationBaseline, syncAppliedCalibration,
      clearRobotContentTransition, abandonProbeRun, maybeStartProbeCalibration, },
    effects: { endTakeMix: () => takeController.endMix(),
      reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()),
      reportSourceStatus: () => broadcastJson(sourceStatusPayload()), reportStatus: () => broadcastStatus(),
      resetMicAudibility, resetMicLevel: () => micLevel.reset(), },
  })`.replace(/\s/g, ''));
  const code = sourceCode(server), at = code.indexOf('const relayCalibrationLifecycle =');
  assert.equal(Array.from(code.matchAll(/createRelayCalibrationLifecycle\(/g)).length, 1);
  for (const name of ['session', 'calibration', 'timingRuntime', 'bootProbeRuntime', 'backingRuntime',
    'robotPlayerOffset', 'robotContentTimeline', 'takeController', 'micLevel',
    'relayCalibration', 'relayContentCalibration', 'relayRobotMapping']) {
    const owner = code.indexOf(`const ${name} =`);
    assert.ok(owner >= 0 && owner < at, `${name}: constructed before lifecycle`);
  }
  assert.doesNotMatch(code.slice(0, at), /\bawait\b/);
  assert.ok(at < code.indexOf('relayMixPump.start();'));
  assert.ok(at < code.indexOf('const youtubeTimelineTimer ='));
  assert.ok(at < code.indexOf('const relayBootProbe ='), 'boot commands remain inert hoisted function refs');
  assert.doesNotMatch(construction, /relayBootProbe\./);
});

const productionEntries = [
  ['invalidateMicTiming', 'message'], ['stopLiveSource', ''], ['restartManualBootCalibration', 'nowMs'],
] as const;

test('three live lifecycle wrappers preserve void signatures and retain no duplicate teardown or dead helper', () => {
  for (const [name, args] of productionEntries) {
    const code = functionCode(server, name);
    assert.equal(code.slice(code.indexOf('{') + 1, code.lastIndexOf('}')).trim(),
      `relayCalibrationLifecycle.${name}(${args});`);
  }
  assert.equal(hasFunction(server, 'clearBootCalibrationState'), false);
  for (const name of ['liveSourceStop', 'micTimingInvalidation', 'manualBootRecalibration']) {
    assert.doesNotMatch(sourceCode(server), new RegExp(`const ${name}Coordinator\\b`));
  }
  for (const path of ['./relay-live-source-stop-coordinator.js', './relay-mic-timing-invalidation-coordinator.js',
    './relay-manual-boot-recalibration-coordinator.js']) assert.equal(importSources(server).includes(path), false);
  assert.match(functionCode(server, 'invalidateMicTiming'), /message: string/);
  assert.match(functionCode(server, 'restartManualBootCalibration'), /nowMs: number/);
});

function actualProductionEntries(owner: Workflow): Workflow {
  const declarations = productionEntries.map(([name]) =>
    functionCode(server, name).replaceAll(': string', '').replaceAll(': number', ''));
  return new Function('relayCalibrationLifecycle',
    `${declarations.join('\n')}\nreturn {invalidateMicTiming, stopLiveSource, restartManualBootCalibration};`)(owner) as Workflow;
}

test('actual server lifecycle forwarding preserves complete branch, clock, return and effect traces', () => {
  const variants = [{}, { collecting: true }, { active: false }, { active: false, collecting: true }];
  const calls: Array<[keyof Workflow, unknown[]]> = [
    ['invalidateMicTiming', ['ownership']], ['invalidateMicTiming', ['Microphone capture changed.']],
    ['stopLiveSource', []], ['restartManualBootCalibration', [0]], ['restartManualBootCalibration', [77]],
    ['restartManualBootCalibration', [123.25]],
  ];
  for (const variant of variants) for (const [name, args] of calls) {
    const direct = fixture(variant), forwarded = fixture(variant);
    assert.deepEqual(Reflect.apply(actualProductionEntries(forwarded.workflow)[name], undefined, args),
      Reflect.apply(direct.workflow[name], undefined, args), `${name}: return`);
    assert.deepEqual(forwarded.events, direct.events, `${name}: complete trace`);
    assert.deepEqual(forwarded.state, direct.state, `${name}: state`);
  }
});

test('actual manual command handler retains owner and Take admission before invoking lifecycle', () => {
  const callback = objectArrowCallbackCode(server, 'commandProtocol', 'startTimingCalibration');
  for (const mode of ['not-owner', 'take-blocked', 'admitted'] as const) {
    const f = fixture(), replies: unknown[] = [];
    const inputs = { requireMicOwnerCommand: () => { f.events.push('command.owner'); return mode !== 'not-owner'; },
      performance: { now: () => { f.events.push('command.clock'); return 77; } },
      productStatusPayload: () => { f.events.push('command.product'); return { actions: {
        canStartCalibration: mode === 'admitted', startCalibrationBlockedReason: 'take-active',
        startCalibrationMode: 'boot-probe' } }; },
      sendJson: (_socket: unknown, payload: unknown) => { f.events.push('command.reject'); replies.push(payload); },
      restartManualBootCalibration: actualProductionEntries(f.workflow).restartManualBootCalibration };
    const handler = new Function(...Object.keys(inputs), `return ({${callback}}).startTimingCalibration;`)(...Object.values(inputs)) as (socket: object) => void;
    handler({});
    if (mode === 'not-owner') assert.deepEqual(f.events, ['command.owner']);
    else if (mode === 'take-blocked') {
      assert.deepEqual(f.events, ['command.owner', 'command.clock', 'command.product', 'command.reject']);
      assert.deepEqual(replies, [{ type: 'calibration-command-rejected', reason: 'take-active' }]);
      assert.equal(f.state.validation, true); assert.equal(f.state.confirmed, true); assert.equal(f.state.kind, 'content');
    } else assert.deepEqual(f.events, ['command.owner', 'command.clock', 'command.product', ...manualTrace]);
  }
});

type Workflow = {
  invalidateMicTiming(message: string): void;
  stopLiveSource(): void;
  restartManualBootCalibration(nowMs: number): void;
};

type Ports = RelayCalibrationLifecycleDependencies;
type WorkflowInput = {
  session: Ports['mix']; calibration: Ports['calibration']; timingRuntime: Ports['timing'];
  backingRuntime: Ports['backing']; robotPlayerOffset: Ports['offset']; robotContentTimeline: Ports['contentTimeline'];
  bootProbeRuntime: Readonly<Pick<Ports['probe'], 'resetCorrelations'>>;
  clearBootCalibrationState(): void;
  clearContentValidationBaseline(): void; syncAppliedCalibration(): void;
  clearRobotContentTransition(): void; abandonProbeRun(): void; maybeStartProbeCalibration(nowMs: number): void;
  takeController: { endMix(): void };
  timingCalibrationStatusPayload(): { type: string }; sourceStatusPayload(): { type: string };
  broadcastJson(value: { type: string }): void; broadcastStatus(): void;
  resetMicAudibility(): void; micLevel: { reset(): void };
};

// C0's real server adapter and all 128 fixed oracles are archived. Only the
// entry changes. The narrow probe observation port preserves the fixture's
// clear trace while executing the same canonical BootProbeRuntime command.
function workflowFromPorts(d: WorkflowInput): Workflow {
  return createRelayCalibrationLifecycle({
    mix: d.session, calibration: d.calibration, timing: d.timingRuntime,
    backing: d.backingRuntime, offset: d.robotPlayerOffset, contentTimeline: d.robotContentTimeline,
    probe: { clear: d.clearBootCalibrationState, resetCorrelations: () => d.bootProbeRuntime.resetCorrelations() },
    commands: { clearContentValidation: d.clearContentValidationBaseline, syncAppliedCalibration: d.syncAppliedCalibration,
      clearRobotContentTransition: d.clearRobotContentTransition, abandonProbeRun: d.abandonProbeRun,
      maybeStartProbeCalibration: d.maybeStartProbeCalibration },
    effects: { endTakeMix: () => d.takeController.endMix(),
      reportTimingStatus: () => d.broadcastJson(d.timingCalibrationStatusPayload()),
      reportSourceStatus: () => d.broadcastJson(d.sourceStatusPayload()), reportStatus: d.broadcastStatus,
      resetMicAudibility: d.resetMicAudibility, resetMicLevel: () => d.micLevel.reset() },
  });
}

function fixture(options: { active?: boolean; collecting?: boolean; throwAt?: string } = {}) {
  const events: string[] = [];
  const state = { active: options.active ?? true, collecting: options.collecting ?? false,
    confirmed: true, kind: 'content', retry: 123, boot: true, validation: true,
    offset: true, timeline: true, transition: true, audibility: true, level: true };
  function note(event: string) {
    events.push(event);
    if (options.throwAt === event) throw new Error(`port threw at ${event}`);
  }
  const dependencies = {
    backingRuntime: { cancelGrace() { note('backing.cancel-grace'); },
      retireRobotRoute() { note('backing.retire-route'); } },
    session: { get active() { note('mix.active'); return state.active; },
      stop() { note('mix.stop'); state.active = false; } },
    takeController: { endMix() { note('take.end-mix:own-default'); return false; } },
    clearBootCalibrationState() { note('boot.clear'); state.boot = false; },
    clearContentValidationBaseline() { note('validation.clear'); state.validation = false; },
    robotPlayerOffset: { reset() { note('offset.reset'); state.offset = false; } },
    robotContentTimeline: { reset() { note('timeline.reset'); state.timeline = false; } },
    clearRobotContentTransition() { note('transition.clear'); state.transition = false; },
    calibration: {
      get collecting() { note('cal.collecting'); return state.collecting; },
      fail(message: string) { note(`cal.fail:${message}`); state.collecting = false; },
      reset() { note('cal.reset'); state.collecting = false; state.confirmed = false; },
      beginExternalRecalibration() { note('cal.begin-external'); state.collecting = false; },
    },
    timingRuntime: {
      clearCalibrationKind() { note('timing.clear-kind'); state.kind = 'none'; },
      resetAutoCalibrationSchedule() { note('timing.reset-retry'); state.retry = 0; },
      beginBootProbe(automatic: boolean) { note(`timing.begin-boot:${automatic}`); state.kind = 'boot-probe'; },
    },
    syncAppliedCalibration() { note('application.sync'); return false; },
    abandonProbeRun() { note('probe.abandon'); },
    bootProbeRuntime: { resetCorrelations() { note('probe.reset-correlations'); } },
    maybeStartProbeCalibration(nowMs: number) { note(`probe.admit:${nowMs}`); },
    timingCalibrationStatusPayload() { note('payload.timing'); return { type: 'timing' }; },
    sourceStatusPayload() { note('payload.source'); return { type: 'source' }; },
    broadcastJson(value: { type: string }) { note(`publish.${value.type}`); },
    broadcastStatus() { note('publish.status'); },
    resetMicAudibility() { note('audibility.reset'); state.audibility = false; },
    micLevel: { reset() { note('level.reset'); state.level = false; } },
  };
  return { events, state, dependencies, workflow: workflowFromPorts(dependencies) };
}

const timingPublication = ['payload.timing', 'publish.timing', 'payload.source', 'publish.source'];

test('new lifecycle constructor reads no canonical owner, command or effect property', () => {
  const f = fixture();
  const poison = <T extends object>(port: T): T => new Proxy(port, {
    get(_target, property) { throw new Error(`constructor read ${String(property)}`); },
  });
  const workflow = createRelayCalibrationLifecycle({
    mix: poison(f.dependencies.session), calibration: poison(f.dependencies.calibration),
    timing: poison(f.dependencies.timingRuntime), backing: poison(f.dependencies.backingRuntime),
    probe: poison({ clear: f.dependencies.clearBootCalibrationState,
      resetCorrelations: f.dependencies.bootProbeRuntime.resetCorrelations }),
    offset: poison(f.dependencies.robotPlayerOffset), contentTimeline: poison(f.dependencies.robotContentTimeline),
    commands: poison({ clearContentValidation() {}, syncAppliedCalibration() {},
      clearRobotContentTransition() {}, abandonProbeRun() {}, maybeStartProbeCalibration(_nowMs: number) {} }),
    effects: poison({ endTakeMix() {}, reportTimingStatus() {}, reportSourceStatus() {},
      reportStatus() {}, resetMicAudibility() {}, resetMicLevel() {} }),
  });
  assert.deepEqual(Object.keys(workflow).sort(),
    ['invalidateMicTiming', 'restartManualBootCalibration', 'stopLiveSource']);
  assert.deepEqual(f.events, []);
  assert.equal(f.state.confirmed, true);
  assert.equal(f.state.active, true);
});

test('calibration module owns no scheduler, async boundary, duplicate authority or domain construction', () => {
  const module = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(sourceCode(module),
    /\b(?:setTimeout|setInterval|queueMicrotask|async|await)\b|new (?:AudioSession|CalibrationSession|ContentCalibrationValidator|TimingRuntime|BootProbeRuntime|RobotContentTimelineMapper|Map|WeakMap)\b/);
  assert.doesNotMatch(sourceCode(module), /syncConfirmedAuthority\(|broadcastJson\(|let\s+(?:lastAutoCalibrationAt|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/);
  assert.doesNotMatch(functionCode(module, 'createRelayCalibrationLifecycle'), /\blet\b/);
});
const stopTrace = ['backing.cancel-grace', 'backing.retire-route', 'mix.active', 'take.end-mix:own-default',
  'boot.clear', 'validation.clear', 'offset.reset', 'timeline.reset', 'transition.clear', 'mix.stop',
  'cal.reset', 'timing.clear-kind', 'timing.reset-retry', ...timingPublication, 'publish.status',
  'audibility.reset', 'level.reset'];
const inactiveStopTrace = ['backing.cancel-grace', 'backing.retire-route', 'mix.active',
  'audibility.reset', 'level.reset'];
const captureTrace = ['boot.clear', 'validation.clear', 'application.sync', ...timingPublication];
const genericTrace = ['boot.clear', 'validation.clear', 'cal.collecting', 'cal.reset',
  'timing.clear-kind', 'timing.reset-retry', 'application.sync', ...timingPublication];
const manualTrace = ['validation.clear', 'cal.begin-external', 'application.sync',
  'timing.begin-boot:false', 'probe.abandon', 'probe.reset-correlations', 'probe.admit:77', ...timingPublication];

test('lifecycle construction is inert and does not read any runtime fact or publish', () => {
  const f = fixture();
  assert.deepEqual(f.events, []);
  assert.deepEqual(Object.keys(f.workflow).sort(),
    ['invalidateMicTiming', 'restartManualBootCalibration', 'stopLiveSource']);
  assert.equal(f.state.kind, 'content');
  assert.equal(f.state.confirmed, true);
});

test('active live stop keeps Take own clock, every teardown and publication before meter resets', () => {
  const f = fixture();
  assert.equal(f.workflow.stopLiveSource(), undefined, 'server entry never returns coordinator boolean');
  assert.deepEqual(f.events, stopTrace);
  assert.equal(f.state.active, false);
  assert.equal(f.state.confirmed, false);
  assert.equal(f.state.kind, 'none');
  assert.equal(f.state.retry, 0);
});

test('inactive and repeated stop still retire route and reset both meters but do not destroy inactive timing', () => {
  const f = fixture({ active: false });
  f.workflow.stopLiveSource();
  assert.deepEqual(f.events, inactiveStopTrace);
  assert.equal(f.state.confirmed, true);
  assert.equal(f.state.boot, true);
  assert.equal(f.state.validation, true);
  assert.equal(f.state.kind, 'content');
  assert.equal(f.state.retry, 123);
  const repeated = fixture();
  repeated.workflow.stopLiveSource();
  repeated.events.length = 0;
  repeated.workflow.stopLiveSource();
  assert.deepEqual(repeated.events, inactiveStopTrace);
});

test('capture replacement is exact message matching and preserves confirmed history, kind and retry', () => {
  const f = fixture({ collecting: true });
  assert.equal(f.workflow.invalidateMicTiming('Microphone capture changed.'), undefined);
  assert.deepEqual(f.events, captureTrace);
  assert.equal(f.state.confirmed, true);
  assert.equal(f.state.collecting, true, 'capture special case does not fail/reset content collection');
  assert.equal(f.state.kind, 'content');
  assert.equal(f.state.retry, 123);
});

for (const collecting of [false, true]) {
  test(`generic Mic invalidation uses ${collecting ? 'fail' : 'reset'} before clearing kind and retry`, () => {
    const f = fixture({ collecting });
    assert.equal(f.workflow.invalidateMicTiming('ownership'), undefined);
    const expected = genericTrace.map(event => event === 'cal.reset' && collecting ? 'cal.fail:ownership' : event);
    assert.deepEqual(f.events, expected);
    assert.equal(f.state.confirmed, collecting);
    assert.equal(f.state.kind, 'none');
    assert.equal(f.state.retry, 0);
  });
}

test('manual restart keeps previous confirmed authority and syncs before switching candidate or sampling admission', () => {
  const f = fixture({ collecting: true });
  assert.equal(f.workflow.restartManualBootCalibration(77), undefined);
  assert.deepEqual(f.events, manualTrace);
  assert.equal(f.state.confirmed, true);
  assert.equal(f.state.kind, 'boot-probe');
  assert.equal(f.state.retry, 123);
  assert.equal(f.state.boot, true, 'manual resetCorrelations is not clear retained Boot calibration');
});

for (const message of ['Microphone capture changed', 'Microphone capture changed. ', '']) {
  test(`non-exact capture reason uses generic invalidation: ${JSON.stringify(message)}`, () => {
    const f = fixture();
    f.workflow.invalidateMicTiming(message);
    assert.deepEqual(f.events, genericTrace);
    assert.equal(f.state.confirmed, false);
  });
}

const transactions = [
  { name: 'active stop', trace: stopTrace, invoke: (w: Workflow) => w.stopLiveSource() },
  { name: 'inactive stop', trace: inactiveStopTrace, options: { active: false }, invoke: (w: Workflow) => w.stopLiveSource() },
  { name: 'capture invalidation', trace: captureTrace, invoke: (w: Workflow) => w.invalidateMicTiming('Microphone capture changed.') },
  { name: 'generic invalidation', trace: genericTrace, invoke: (w: Workflow) => w.invalidateMicTiming('ownership') },
  { name: 'collecting generic invalidation', trace: genericTrace.map(event =>
    event === 'cal.reset' ? 'cal.fail:ownership' : event), options: { collecting: true },
    invoke: (w: Workflow) => w.invalidateMicTiming('ownership') },
  { name: 'manual restart', trace: manualTrace, invoke: (w: Workflow) => w.restartManualBootCalibration(77) },
];
for (const transaction of transactions) for (const [index, event] of transaction.trace.entries()) {
  test(`${transaction.name}: exception at ${event} stops all later effects`, () => {
    const f = fixture({ ...transaction.options, throwAt: event });
    assert.throws(() => transaction.invoke(f.workflow), { message: `port threw at ${event}` });
    assert.deepEqual(f.events, transaction.trace.slice(0, index + 1));
  });
}

for (const nowMs of [0, -7, 123.25]) {
  test(`manual entry passes its original monotonic timestamp unchanged: ${nowMs}`, () => {
    const f = fixture();
    f.workflow.restartManualBootCalibration(nowMs);
    assert.deepEqual(f.events, manualTrace.map(event => event === 'probe.admit:77' ? `probe.admit:${nowMs}` : event));
  });
}

type Pending = { signal: AbortSignal | undefined;
  resolve(value: TimingCalibrationAnalysis): void; reject(error: unknown): void };
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function measurement(lag: number): TimingCalibrationAnalysis {
  return { micLagMs: lag, confidence: 0.9, segmentLagsMs: [lag], segmentCorrelations: [0.9],
    micLevelDbfs: -20, backingLevelDbfs: -12 };
}

// Real authority owners and public S22a/S22b/S21 workflows. External transport,
// analyzer answers, Take endMix and UI meter/report effects are controlled.
// This is neither acoustic proof nor Take storage/admission proof.
function measuredFixture() {
  const control = { now: 0, micRate: 48_000, backingRate: 48_000,
    route: true, deferredCalibration: true, deferredValidation: true,
    takePhase: 'idle' as 'idle' | 'recording' | 'finalizing',
    grace: true, transition: true, audibility: true, level: true };
  const events: string[] = [];
  const publications: Array<{ tag: string; revision: number; authority: string; candidate: string;
    authorityRevision: number; lag: number | null; target: number | null;
    baseline: number; validator: string; calState: string }> = [];
  const pendingCalibration: Pending[] = [], pendingValidation: Pending[] = [];
  const mix = new AudioSession({ sampleRate: 48_000, frameMs: 20, prebufferMs: 0,
    backingGain: 1, retentionMs: 5_000 });
  mix.start(0);
  function ingestCaptures(micGeneration = 2, backingGeneration = 3) {
    mix.ingestMic({ generation: micGeneration, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, control.micRate, control.now);
    mix.ingestBacking({ generation: backingGeneration, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, control.backingRate, control.now);
  }
  ingestCaptures();
  const source = new SourceRuntime<{ isRobotSource?: boolean }>({ isConnected: () => true });
  source.attachRobot({});
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  const probe = new BootProbeRuntime({ maxAttempts: 1, retryMs: 100 });
  const mapper = new RobotContentTimelineMapper({ sampleRate: 48_000, freshForMs: 10_000 });
  const offset = new RobotPlayerOffsetTracker({ freshForMs: 10_000, windowMs: 1_000 });
  offset.record(100, 0);
  function liveContext(): CalibrationContext {
    return { sessionGeneration: mix.generation, micGeneration: mix.micGeneration,
      backingGeneration: mix.backingGeneration, micSourceRate: control.micRate,
      backingSourceRate: control.backingRate, sourceGeneration: source.generation };
  }
  function bootContext(): BootProbeContext {
    const value = liveContext();
    return { sessionGeneration: value.sessionGeneration, micGeneration: value.micGeneration,
      backingGeneration: value.backingGeneration, micSourceRate: value.micSourceRate,
      backingSourceRate: value.backingSourceRate };
  }
  function publish(tag: string) {
    events.push(tag);
    publications.push({ tag, revision: calibration.confirmedRevision,
      authorityRevision: timing.authorityRevision, authority: timing.authorityKind,
      candidate: timing.calibrationKind, lag: mix.alignment.calibratedMicLagMs,
      target: mix.calibratedMicLagTarget, baseline: timing.contentValidationBaselineRevision,
      validator: validator.status(control.now).state, calState: calibration.status().state });
  }
  const calibration = new CalibrationSession({ sampleRate: 48_000, durationMs: 20,
    timeoutMs: 1_000, agreementWindows: 1, now: () => control.now, context: liveContext,
    analyze: (_mic, _backing, _rate, _maxLag, signal) => control.deferredCalibration
      ? new Promise<TimingCalibrationAnalysis>((resolve, reject) => pendingCalibration.push({ signal, resolve, reject }))
      : measurement(300),
    onSettled: () => {
      events.push('settled:authority');
      timing.syncConfirmedAuthority({ confirmedRevision: calibration.confirmedRevision,
        hasConfirmedResult: calibration.confirmedResult !== null });
      events.push('settled:mixer'); applier.syncApplied();
      publish('settled:timing'); publish('settled:source');
    },
  });
  const validator = new ContentCalibrationValidator({ sampleRate: 48_000, durationMs: 20,
    timeoutMs: 1_000, intervalMs: 10, retryMs: 5, deviationThresholdMs: 10,
    agreementToleranceMs: 5, now: () => control.now, context: liveContext,
    analyze: (_mic, _backing, _rate, _maxLag, signal) => control.deferredValidation
      ? new Promise<TimingCalibrationAnalysis>((resolve, reject) => pendingValidation.push({ signal, resolve, reject }))
      : measurement(300),
    onChange: () => publish('validator:timing'),
    onDriftConfirmed: result => {
      timing.markContentAuthority(); timing.prepareContentValidationSlew(calibration.confirmedRevision + 1);
      calibration.applyValidatedResult(result); timing.markContentValidationBaseline(calibration.confirmedRevision);
    },
  });
  const blocked = () => control.takePhase !== 'idle';
  const settled = () => probe.status(control.now).error !== null
    || (probe.pathDifferenceMs !== null && probe.completedContextMatches(bootContext()));
  const applier = createRelayCalibrationOrchestration({
    config: { reapplyThresholdMs: 20 }, clock: { now: () => control.now }, mix,
    mic: { get sampleRate() { return control.micRate; } },
    backing: { get sampleRate() { return control.backingRate; } }, source, calibration,
    timing, probe, contentTimeline: mapper,
    queries: { takeBlocksCalibration: blocked, robotRouteActive: () => control.route,
      robotProbeTimingActive: () => control.route, bootProbeSettled: settled, bootProbeContext: bootContext,
      roomHasSong: () => true, robotDeltaIsFresh: () => true, robotDeltaEverEstablished: () => true,
      robotContentMappingReady: now => mapper.isReady(liveContext(), now),
      currentDeltaMs: () => 100, currentPlaybackRate: () => 1 },
  });
  const content = createRelayContentCalibrationOrchestration({
    config: { autoEnabled: true, validationEnabled: true }, clock: { now: () => control.now },
    mix, calibration, timing, validator, backing: { connected: () => true },
    mic: { controlConnected: () => true },
    queries: { calibrationContext: liveContext, appliedCalibrationKind: () => applier.appliedKind(),
      calibrationIsStale: () => applier.isStale(), takeBlocksCalibration: blocked,
      robotRouteActive: () => control.route, bootProbeSettled: settled,
      robotContentEvidenceMappingReady: now => mapper.isReady(liveContext(), now) && !mapper.needsBackingBoundary(liveContext()),
      bothStreamsFlowing: () => true, currentTimelineStatus: () => ({ connected: true, state: 1 }),
      probeCalibrationExhausted: () => probe.status(control.now).error !== null },
    effects: { reportTimingStatus: () => publish('auto:timing') },
  });
  const bootWorkflow = createRelayBootProbeOrchestration({
    config: { sampleRate: 48_000, leadMs: 20, searchMarginMs: 20, referenceMs: 20,
      analysisTimeoutMs: 100, minCorrelation: 0.5, maxCaptureGapMs: 20, reapplyThresholdMs: 20, debug: false },
    mix, calibration, timing, probe, mic: { publisher: {}, controlConnected: () => true,
      get sampleRate() { return control.micRate; } },
    backing: { isRobot: true, connected: () => true, get sampleRate() { return control.backingRate; } },
    source: { socket: {}, connected: () => source.connected() },
    queries: { robotRouteActive: () => control.route, robotProbeTimingActive: () => control.route,
      takeBlocksCalibration: blocked, micPlayable: () => true, backingPlayable: () => true,
      calibrationIsStale: () => applier.isStale(), probeStatus: now => probe.status(now),
      appliedCalibrationKind: () => applier.appliedKind(), calibrationApplicability: kind => applier.applicability(kind),
      roomHasSong: () => true, robotDeltaIsFresh: () => true, currentDeltaMs: () => 100,
      currentPlaybackRate: () => 1, bootProbeAdvanceMs: now => applier.bootAdvance(now) },
    effects: { sendProbe: (_socket, message) => events.push(`probe.send:${message.target}`),
      reportTimingStatus: () => publish('probe:timing'), debugLog: () => {} },
  });
  function restoreBoot() {
    probe.recordCalibration(bootContext(), { advanceMs: 240, micLatencyMs: 240,
      backingLatencyMs: 100, deltaMs: 100, confidence: 0.9 });
    mapper.notePlayerOffset(100, liveContext(), control.now, 1);
  }
  restoreBoot();
  const dependencies = {
    backingRuntime: { cancelGrace() { events.push('backing.cancel-grace'); control.grace = false; },
      retireRobotRoute() { events.push('backing.retire-route'); control.route = false; } },
    session: mix, calibration, timingRuntime: timing, bootProbeRuntime: probe,
    takeController: { endMix() { events.push('take.end-mix:own-default'); return false; } },
    clearBootCalibrationState() { events.push('boot.clear'); probe.clear(); },
    clearContentValidationBaseline() { events.push('validation.clear'); content.clearBaseline(); },
    robotPlayerOffset: offset, robotContentTimeline: mapper,
    clearRobotContentTransition() { events.push('transition.clear'); control.transition = false; },
    syncAppliedCalibration() { events.push('application.sync'); return applier.syncApplied(); },
    abandonProbeRun() { events.push('probe.abandon'); bootWorkflow.abandon(); },
    maybeStartProbeCalibration(now: number) { events.push(`probe.admit:${now}`); bootWorkflow.stepAdmission(now); },
    timingCalibrationStatusPayload: () => ({ type: 'timing' }), sourceStatusPayload: () => ({ type: 'source' }),
    broadcastJson(value: { type: string }) { publish(`publish.${value.type}`); },
    broadcastStatus() { publish('publish.status'); },
    resetMicAudibility() { events.push('audibility.reset'); control.audibility = false; },
    micLevel: { reset() { events.push('level.reset'); control.level = false; } },
  };
  const workflow = workflowFromPorts(dependencies);
  let calSample = 0, validationSample = 0;
  function seedContent(lag = 240) { timing.markContentAuthority(); calibration.applyValidatedResult(measurement(lag)); }
  function feedCalibration() {
    const pcm = new Int16Array(960);
    calibration.observeMic(pcm, calSample); calibration.observeBacking(pcm, calSample); calSample += pcm.length;
  }
  function feedValidation() {
    const pcm = new Int16Array(960);
    validator.observeMic(pcm, validationSample); validator.observeBacking(pcm, validationSample); validationSample += pcm.length;
  }
  function startCalibration() {
    timing.beginContentCalibration(control.now, true); calibration.start(control.now); feedCalibration();
  }
  function startValidation() {
    content.syncBaseline(control.now); control.now += 10; content.stepValidation(control.now); feedValidation();
  }
  function clearObservations() { events.length = 0; publications.length = 0; }
  return { workflow, control, events, publications, mix, source, calibration, validator,
    timing, probe, mapper, offset, content, applier, bootWorkflow, seedContent,
    restoreBoot, ingestCaptures, startCalibration, startValidation, feedCalibration, feedValidation,
    pendingCalibration, pendingValidation, liveContext, clearObservations };
}

type Measured = ReturnType<typeof measuredFixture>;
function truth(h: Measured) {
  return { revision: h.calibration.confirmedRevision, confirmed: h.calibration.confirmedResult,
    authority: h.timing.authorityKind, authorityRevision: h.timing.authorityRevision,
    candidate: h.timing.calibrationKind, baseline: h.timing.contentValidationBaselineRevision,
    slew: h.timing.contentValidationSlewRevision, lag: h.mix.alignment.calibratedMicLagMs,
    target: h.mix.calibratedMicLagTarget, validator: h.validator.status(h.control.now),
    calibration: h.calibration.status(), events: h.events.slice(), publications: h.publications.slice() };
}

for (const readStatus of [false, true]) {
  test(`real manual restart and failed preferred candidate retain content authority, status read=${readStatus}`, () => {
    const h = measuredFixture(); h.seedContent(); h.content.syncBaseline(0); h.clearObservations();
    if (readStatus) { h.calibration.status(); h.applier.appliedKind(); h.content.validationPathReady(0); }
    h.workflow.restartManualBootCalibration(77);
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.calibration.confirmedResult?.micLagMs, 240);
    assert.equal(h.timing.authorityKind, 'content');
    assert.equal(h.timing.calibrationKind, 'boot-probe');
    assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
    assert.equal(h.validator.hasBaseline, false);
    assert.equal(h.probe.pathDifferenceMs, 140, 'manual abandon/resetCorrelations keeps retained Boot');
    assert.deepEqual(h.events, ['validation.clear', 'validator:timing', 'application.sync',
      'probe.abandon', 'probe.admit:77', 'probe.send:mic', 'probe:timing', 'publish.timing', 'publish.source']);
    h.bootWorkflow.failAttempt('mic', 'controlled candidate failure', 80);
    assert.equal(h.probe.status(80).error !== null, true);
    assert.equal(h.timing.calibrationKind, 'content');
    assert.equal(h.timing.authorityKind, 'content');
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
  });
}

test('real generic collecting failure publishes settlement before kind withdrawal and outer publication', () => {
  const h = measuredFixture(); h.seedContent(); h.content.syncBaseline(0); h.startCalibration(); h.clearObservations();
  h.workflow.invalidateMicTiming('ownership');
  assert.deepEqual(h.events, ['boot.clear', 'validation.clear', 'validator:timing',
    'settled:authority', 'settled:mixer', 'settled:timing', 'settled:source',
    'application.sync', 'publish.timing', 'publish.source']);
  assert.equal(h.publications[1].authority, 'content', 'synchronous fail/onSettled still sees retained authority');
  assert.equal(h.publications.at(-1)?.authority, 'none', 'outer transaction withdraws authority after callback');
  assert.equal(h.calibration.confirmedResult?.micLagMs, 240);
  assert.equal(h.mix.alignment.calibratedMicLagMs, null);
  assert.equal(h.pendingCalibration[0].signal?.aborted, true);
});

test('real inactive live stop leaves domain history and baseline intact while retiring route and meters', () => {
  const h = measuredFixture(); h.seedContent(); h.content.syncBaseline(0); h.mix.stop(); h.clearObservations();
  h.workflow.stopLiveSource();
  assert.deepEqual(h.events, ['backing.cancel-grace', 'backing.retire-route', 'audibility.reset', 'level.reset']);
  assert.equal(h.calibration.confirmedResult?.micLagMs, 240);
  assert.equal(h.timing.authorityKind, 'content');
  assert.equal(h.validator.hasBaseline, true);
  assert.equal(h.probe.pathDifferenceMs, 140);
});

const interruptions: Array<{ name: string; capture?: boolean; run(h: Measured): void }> = [
  { name: 'manual restart', run: h => h.workflow.restartManualBootCalibration(h.control.now) },
  { name: 'ownership invalidation', run: h => h.workflow.invalidateMicTiming('ownership') },
  { name: 'active live stop', run: h => h.workflow.stopLiveSource() },
  { name: 'Mic generation capture invalidation', capture: true, run: h => {
    h.mix.ingestMic({ generation: 20, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, h.control.micRate, h.control.now);
    h.workflow.invalidateMicTiming('Microphone capture changed.');
  } },
  { name: 'Mic rate-only capture invalidation', capture: true, run: h => {
    h.control.micRate = 44_100; h.workflow.invalidateMicTiming('Microphone capture changed.');
  } },
];

for (const interruption of interruptions) for (const worker of ['calibration', 'validation'] as const)
  for (const completion of ['resolve', 'reject'] as const) {
    test(`real ${worker} old ${completion} after ${interruption.name} cannot promote old evidence`, async () => {
      const h = measuredFixture(); h.seedContent();
      if (worker === 'calibration') h.startCalibration(); else h.startValidation();
      const pending = worker === 'calibration' ? h.pendingCalibration : h.pendingValidation;
      assert.equal(pending.length, 1);
      const old = pending[0]; interruption.run(h);
      const capturePending = interruption.capture && worker === 'calibration';
      assert.equal(old.signal?.aborted, !capturePending);
      const before = truth(h);
      if (completion === 'resolve') old.resolve(measurement(399)); else old.reject(new Error('old rejection'));
      await nextTurn();
      if (!capturePending) assert.deepEqual(truth(h), before);
      else {
        assert.equal(h.calibration.confirmedRevision, before.revision);
        assert.deepEqual(h.calibration.confirmedResult, before.confirmed);
        assert.equal(h.timing.authorityKind, before.authority);
        assert.equal(h.mix.alignment.calibratedMicLagMs, null);
        assert.equal(h.calibration.status().state, 'failed');
        assert.deepEqual(h.events.slice(before.events.length),
          ['settled:authority', 'settled:mixer', 'settled:timing', 'settled:source'],
          'uncancelled capture worker preserves existing failure publication, not promotion');
      }
    });
  }

test('real generic noncollecting invalidation resets confirmed state before withdrawing timing metadata', () => {
  const h = measuredFixture(); h.seedContent(); h.content.syncBaseline(0); h.clearObservations();
  h.workflow.invalidateMicTiming('ownership');
  assert.deepEqual(h.events, ['boot.clear', 'validation.clear', 'validator:timing',
    'application.sync', 'publish.timing', 'publish.source']);
  assert.equal(h.calibration.confirmedResult, null);
  assert.equal(h.timing.authorityKind, 'none');
  assert.equal(h.timing.autoCalibrationDue(0), true);
  assert.equal(h.mix.alignment.calibratedMicLagMs, null);
  assert.equal(h.publications[0].authority, 'content', 'baseline clear callback runs before reset');
  assert.equal(h.publications.at(-1)?.authority, 'none');
});

test('real active and repeated live stop clear authority, Boot and mapping only on the active transaction', () => {
  const h = measuredFixture(); h.seedContent(); h.content.syncBaseline(0); h.clearObservations();
  h.workflow.stopLiveSource();
  assert.deepEqual(h.events, ['backing.cancel-grace', 'backing.retire-route', 'take.end-mix:own-default',
    'boot.clear', 'validation.clear', 'validator:timing', 'transition.clear',
    'publish.timing', 'publish.source', 'publish.status', 'audibility.reset', 'level.reset']);
  assert.equal(h.mix.active, false);
  assert.equal(h.calibration.confirmedResult, null);
  assert.equal(h.timing.authorityKind, 'none');
  assert.equal(h.timing.contentValidationBaselineRevision, -1);
  assert.equal(h.probe.pathDifferenceMs, null);
  assert.equal(h.mapper.isReady(h.liveContext(), h.control.now), false);
  assert.equal(h.offset.lastReportedAtMs, -Infinity);
  assert.equal(h.control.transition, false);
  assert.equal(h.control.audibility, false); assert.equal(h.control.level, false);
  h.clearObservations(); h.workflow.stopLiveSource();
  assert.deepEqual(h.events, ['backing.cancel-grace', 'backing.retire-route', 'audibility.reset', 'level.reset']);
});

for (const interruption of interruptions.filter(value => value.capture)) for (const readStatus of [false, true]) {
  test(`real ${interruption.name} leaves confirmed history stale without status settling, read=${readStatus}`, () => {
    const h = measuredFixture(); h.seedContent(); h.content.syncBaseline(0);
    h.timing.beginContentCalibration(0, true); h.clearObservations();
    if (readStatus) { h.calibration.status(); h.applier.appliedKind(); }
    interruption.run(h);
    assert.deepEqual(h.events, ['boot.clear', 'validation.clear', 'validator:timing',
      'application.sync', 'publish.timing', 'publish.source']);
    assert.equal(h.calibration.confirmedResult?.micLagMs, 240);
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.calibration.isStaleFor(h.liveContext()), true);
    assert.equal(h.timing.authorityKind, 'content');
    assert.equal(h.timing.calibrationKind, 'content');
    assert.equal(h.timing.autoCalibrationDue(0), false, 'capture replacement preserves retry schedule');
    assert.equal(h.mix.alignment.calibratedMicLagMs, null);
    assert.equal(h.validator.hasBaseline, false);
  });
}

for (const interruption of interruptions) for (const worker of ['calibration', 'validation'] as const)
  for (const completion of ['resolve', 'reject'] as const) {
    test(`real ${worker} successor survives old ${completion} after ${interruption.name}`, async () => {
      const h = measuredFixture(); h.seedContent();
      if (worker === 'calibration') h.startCalibration(); else h.startValidation();
      const pending = worker === 'calibration' ? h.pendingCalibration : h.pendingValidation;
      const old = pending[0]; interruption.run(h);
      // Explicit new transaction restores live captures, settled Boot and mapping.
      // This is not an invented auto-admission path for a stopped mixer.
      if (!h.mix.active) { h.mix.start(h.control.now); h.ingestCaptures(); }
      h.control.route = true; h.bootWorkflow.abandon(); h.restoreBoot(); h.seedContent(300);
      if (worker === 'calibration') h.startCalibration(); else h.startValidation();
      assert.equal(pending.length, 2);
      const current = pending[1];
      assert.equal(old.signal?.aborted, true); assert.equal(current.signal?.aborted, false);
      assert.equal(h.mix.alignment.calibratedMicLagMs, 300);
      const before = truth(h);
      if (completion === 'resolve') old.resolve(measurement(399)); else old.reject(new Error('old rejection'));
      await nextTurn();
      assert.deepEqual(truth(h), before, 'old completion cannot fail or republish over the successor');
      assert.equal(current.signal?.aborted, false);
      current.resolve(measurement(worker === 'calibration' ? 350 : 300)); await nextTurn();
      if (worker === 'calibration') {
        assert.equal(h.calibration.confirmedRevision, before.revision + 1);
        assert.equal(h.calibration.confirmedResult?.micLagMs, 350);
        assert.equal(h.mix.alignment.calibratedMicLagMs, 350);
      } else {
        assert.equal(h.calibration.confirmedRevision, before.revision);
        assert.equal(h.validator.status(h.control.now).lastOutcome, 'stable');
        assert.equal(h.mix.alignment.calibratedMicLagMs, 300);
      }
    });
  }
