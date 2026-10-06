import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { BootProbeRuntime, type BootProbeContext } from '../src/boot-probe-runtime.js';

import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import { ContentCalibrationValidator, type ConfirmedContentCalibration, type ContentValidationState } from '../src/content-calibration-validator.js';
import { createRelayCalibrationOrchestration, createRelayContentCalibrationOrchestration,
  type RelayContentCalibrationDependencies } from '../src/relay-calibration-orchestration.js';
import { createRelayBootProbeFailureSettlementCoordinator } from '../src/relay-boot-probe-failure-settlement-coordinator.js';
import { createRelayTakeCommandCoordinator } from '../src/relay-take-command-coordinator.js';
import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';
import { SourceRuntime } from '../src/source-runtime.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';
import { TimingRuntime, type TimingCalibrationKind } from '../src/timing-runtime.js';
import { functionCode, hasFunction, importSources, objectArrowCallbackCode,
  parseTypeScriptSource, sourceCode, variableInitializerCode } from './support/source-contract.js';

const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
const productionEntryPoints = [
  ['clearContentValidationBaseline', 'clearBaseline', 'relayContentCalibration.clearBaseline();'],
  ['cancelActiveContentValidation', 'cancelValidation', 'return relayContentCalibration.cancelValidation(nowMs);'],
  ['maybeAutoCalibrate', 'stepAuto', 'relayContentCalibration.stepAuto(nowMs);'],
  ['maybeValidateContentCalibration', 'stepValidation', 'relayContentCalibration.stepValidation(nowMs);'],
] as const;

test('content production binds exactly one inert instance to canonical owners and live named ports', () => {
  assert.equal(importSources(server).filter(p => p === './relay-calibration-orchestration.js').length, 1);
  assert.equal(variableInitializerCode(server, 'relayContentCalibration').replace(/\s/g, ''),
    `createRelayContentCalibrationOrchestration({
      config: { autoEnabled: AUTO_CALIBRATE, validationEnabled: CONTENT_VALIDATION_ENABLED },
      clock: performance, mix: session, calibration, timing: timingRuntime,
      validator: contentCalibrationValidator, backing: backingRuntime, mic: micRuntime,
      queries: { calibrationContext, appliedCalibrationKind, calibrationIsStale, takeBlocksCalibration,
        robotRouteActive, bootProbeSettled, robotContentEvidenceMappingReady, bothStreamsFlowing,
        currentTimelineStatus, probeCalibrationExhausted, },
      effects: { reportTimingStatus: () => broadcastJson(timingCalibrationStatusPayload()) },
    })`.replace(/\s/g, ''));
  const code = sourceCode(server), at = code.indexOf('const relayContentCalibration =');
  assert.equal(Array.from(code.matchAll(/createRelayContentCalibrationOrchestration\(/g)).length, 1);
  for (const name of ['session', 'calibration', 'timingRuntime', 'contentCalibrationValidator',
    'backingRuntime', 'micRuntime', 'relayCalibration', 'relayRobotMapping']) {
    const owner = code.indexOf(`const ${name} =`);
    assert.ok(owner >= 0 && owner < at, `${name} constructed before inert workflow`);
  }
  assert.doesNotMatch(code.slice(0, at), /\bawait\b/);
  assert.ok(at < code.indexOf('relayMixPump.start();'));
  assert.ok(at < code.indexOf('const youtubeTimelineTimer ='));
});

test('four live server seams delegate once and retain cancellation clock defaults without dead algorithms', () => {
  for (const [name, , expected] of productionEntryPoints) {
    const code = functionCode(server, name);
    assert.equal(code.slice(code.indexOf('{') + 1, code.lastIndexOf('}')).trim(), expected, name);
  }
  assert.match(functionCode(server, 'cancelActiveContentValidation'), /nowMs = performance\.now\(\)/);
  for (const name of ['syncContentValidationBaseline', 'contentValidationPathReady']) {
    assert.equal(hasFunction(server, name), false, `${name}: only callers moved together`);
  }
  assert.doesNotMatch(sourceCode(server),
    /decideContentValidationBaselineSync\(|autoContentCalibration(?:PrerequisitesReady|AuthorityAllowsStart|LivePathReady|StartMode)\(|contentValidation(?:PathPrerequisitesReady|AuthorityReady|LivePathReady)\(/);
  assert.equal(importSources(server).some(p =>
    /(?:auto-content-calibration|content-validation-(?:baseline|path))-policy\.js$/.test(p)), false);
});

function productionContentEntries(owner: Workflow, clock: Ports['clock']) {
  const declarations = productionEntryPoints.map(([name]) =>
    functionCode(server, name).replaceAll(': number', ''));
  const entries = productionEntryPoints.map(([name, method]) => `${method}: ${name}`);
  return new Function('relayContentCalibration', 'performance',
    `${declarations.join('\n')}\nreturn {${entries.join(',')}};`)(owner, clock) as
    Pick<Workflow, 'clearBaseline' | 'cancelValidation' | 'stepAuto' | 'stepValidation'>;
}

test('actual server entry execution matches direct owner return, clock, getter, effect and state traces', () => {
  const variants: Array<Parameters<typeof fixture>[0]> = [
    {}, { route: true, result: null }, { route: true, kind: 'boot-probe' },
    { route: true, kind: 'content', stale: true, exhausted: true },
    { takeBlocked: true }, { validatorState: 'suspect' }, { validatorCollecting: true },
    { baseline: false, baselineRevision: -1 }, { mapping: false, route: true },
    { retryDue: false }, { timelineState: 2 },
  ];
  const calls: Array<['clearBaseline' | 'cancelValidation' | 'stepAuto' | 'stepValidation', unknown[]]> = [
    ['clearBaseline', []], ['cancelValidation', []], ['cancelValidation', [undefined]],
    ['cancelValidation', [9]], ['stepAuto', [9]], ['stepValidation', [9]],
  ];
  for (const variant of variants) for (const [method, args] of calls) {
    const direct = fixture(variant), forwarded = fixture(variant);
    const entries = productionContentEntries(forwarded.workflow, forwarded.dependencies.performance);
    assert.deepEqual(Reflect.apply(entries[method], undefined, args),
      Reflect.apply(direct.workflow[method], undefined, args), `${method}: return`);
    assert.deepEqual(forwarded.events, direct.events, `${method}: complete trace`);
    assert.deepEqual(forwarded.state, direct.state, `${method}: state`);
  }
});

test('content tick keeps original ordering and validator alone publishes validation state transitions', () => {
  const tick = variableInitializerCode(server, 'youtubeTimelineTimer');
  const markers = ['dropLegacyCalibrationForRobot();', 'syncAppliedCalibration()',
    'maybeFinishProbeAnalysis(nowMs);', 'maybeStartProbeCalibration(nowMs);',
    'maybeReapplyBootCalibration(nowMs);', 'sweepRobotContentTransition(nowMs);',
    'maybeAutoCalibrate(nowMs);', 'maybeValidateContentCalibration(nowMs);',
    'sweepPreparedSongHandoff(nowMs);', 'participants.sweep(Date.now())', 'broadcastProductStatus(nowMs);'];
  let previous = -1;
  for (const marker of markers) {
    const index = tick.indexOf(marker);
    assert.ok(index > previous, `${marker}: original tick position`);
    previous = index;
    assert.equal(tick.split(marker).length - 1, 1, `${marker}: exactly once`);
  }
  assert.match(tick, /const nowMs = performance\.now\(\)/);
  assert.match(tick, /}, TIMELINE_STATUS_REFRESH_MS\)/);
  const onChange = objectArrowCallbackCode(server, 'contentCalibrationValidator', 'onChange');
  assert.equal(onChange.split('broadcastJson(timingCalibrationStatusPayload())').length - 1, 1);
  const module = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(functionCode(module, 'maybeValidateContentCalibration'),
    /reportTimingStatus|broadcastJson|await|Promise/);
  assert.match(functionCode(module, 'maybeValidateContentCalibration'),
    /contentCalibrationValidator\.tick\(nowMs\);\s*contentCalibrationValidator\.maybeStart\(nowMs\)/);
});

type Workflow = {
  clearBaseline(): void;
  syncBaseline(nowMs: number): void;
  cancelValidation(nowMs?: number): boolean;
  stepAuto(nowMs: number): void;
  validationPathReady(nowMs: number): boolean;
  stepValidation(nowMs: number): void;
};

type Ports = RelayContentCalibrationDependencies;
type WorkflowInput = Ports['queries'] & {
  AUTO_CALIBRATE: boolean;
  CONTENT_VALIDATION_ENABLED: boolean;
  performance: Ports['clock'];
  session: Ports['mix'];
  calibration: Ports['calibration'];
  timingRuntime: Ports['timing'];
  contentCalibrationValidator: Ports['validator'];
  backingRuntime: Ports['backing'];
  micRuntime: Ports['mic'];
  timingCalibrationStatusPayload(): object;
  broadcastJson(payload: object): void;
};

// C0's actual-body adapter and all fixed oracles are archived. Only this entry
// changes; neither the policy decisions nor any expected value is rewritten.
function workflowFromPorts(d: WorkflowInput): Workflow {
  return createRelayContentCalibrationOrchestration({
    config: { autoEnabled: d.AUTO_CALIBRATE, validationEnabled: d.CONTENT_VALIDATION_ENABLED },
    clock: d.performance, mix: d.session, calibration: d.calibration, timing: d.timingRuntime,
    validator: d.contentCalibrationValidator, backing: d.backingRuntime, mic: d.micRuntime,
    queries: { calibrationContext: d.calibrationContext, appliedCalibrationKind: d.appliedCalibrationKind,
      calibrationIsStale: d.calibrationIsStale, takeBlocksCalibration: d.takeBlocksCalibration,
      robotRouteActive: d.robotRouteActive, bootProbeSettled: d.bootProbeSettled,
      robotContentEvidenceMappingReady: d.robotContentEvidenceMappingReady,
      bothStreamsFlowing: d.bothStreamsFlowing, currentTimelineStatus: d.currentTimelineStatus,
      probeCalibrationExhausted: d.probeCalibrationExhausted },
    effects: { reportTimingStatus: () => d.broadcastJson(d.timingCalibrationStatusPayload()) },
  });
}

test('content workflow construction reads no owner, query, clock or publication port', () => {
  const f = fixture();
  const poison = <T extends object>(port: T): T => new Proxy(port, {
    get(_target, property) { throw new Error(`constructor read ${String(property)}`); },
  });
  const owner = createRelayContentCalibrationOrchestration({
    config: { autoEnabled: true, validationEnabled: true },
    clock: poison(f.dependencies.performance), mix: poison(f.dependencies.session),
    calibration: poison(f.dependencies.calibration), timing: poison(f.dependencies.timingRuntime),
    validator: poison(f.dependencies.contentCalibrationValidator),
    backing: poison(f.dependencies.backingRuntime), mic: poison(f.dependencies.micRuntime),
    queries: poison(f.dependencies), effects: poison({ reportTimingStatus() {} }),
  });
  assert.deepEqual(Object.keys(owner).sort(), ['cancelValidation', 'clearBaseline', 'stepAuto',
    'stepValidation', 'syncBaseline', 'validationPathReady']);
  assert.deepEqual(f.events, []);
  assert.equal(f.state.calCollecting, false);
  assert.equal(f.state.baselineRevision, 7);
});

test('calibration module adds no scheduler, async boundary, authority cache or domain owner', () => {
  const module = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(sourceCode(module), /\b(?:setInterval|setTimeout|queueMicrotask|async|await)\b|new (?:AudioSession|CalibrationSession|ContentCalibrationValidator|TimingRuntime|BootProbeRuntime|RobotContentTimelineMapper|Map|WeakMap)\b/);
  assert.doesNotMatch(sourceCode(module), /syncConfirmedAuthority\(|broadcastJson\(|let\s+(?:lastAutoCalibrationAt|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/);
});

const context: CalibrationContext = { sessionGeneration: 1, micGeneration: 2,
  backingGeneration: 3, micSourceRate: 48_000, backingSourceRate: 44_100, sourceGeneration: 4 };
const confirmed = { micLagMs: 240, confidence: 0.9, segmentLagsMs: [240, 240] };

function fixture(overrides: Partial<{
  autoEnabled: boolean; validationEnabled: boolean; takeBlocked: boolean;
  route: boolean; settled: boolean; mapping: boolean; active: boolean;
  calCollecting: boolean; result: typeof confirmed | null; revision: number;
  kind: TimingCalibrationKind; stale: boolean; baseline: boolean; baselineRevision: number;
  validatorState: ContentValidationState; validatorCollecting: boolean;
  retryDue: boolean; backing: boolean; micControl: boolean; streams: boolean;
  timelineConnected: boolean; timelineState: number; exhausted: boolean; throwAt: string | null;
}> = {}) {
  const events: string[] = [];
  const state = {
    autoEnabled: true, validationEnabled: true, takeBlocked: false,
    route: false, settled: true, mapping: true, active: true, calCollecting: false,
    result: confirmed as typeof confirmed | null, revision: 7,
    kind: 'content' as TimingCalibrationKind, stale: false,
    baseline: true, baselineRevision: 7, validatorState: 'waiting' as ContentValidationState,
    validatorCollecting: false, retryDue: true, backing: true, micControl: true, streams: true,
    timelineConnected: true, timelineState: 1, exhausted: false, throwAt: null as string | null,
    ...overrides,
  };
  let seeded: ConfirmedContentCalibration | null = null;
  const note = (event: string) => {
    events.push(event);
    if (state.throwAt === event) throw new Error(`port threw at ${event}`);
  };
  const performance = { now() { note('clock'); return 701; } };
  const dependencies = {
    AUTO_CALIBRATE: state.autoEnabled, CONTENT_VALIDATION_ENABLED: state.validationEnabled,
    performance,
    session: { get active() { note('mix.active'); return state.active; } },
    calibration: {
      get confirmedResult() { note('cal.confirmed'); return state.result; },
      get confirmedRevision() { note('cal.revision'); return state.revision; },
      get collecting() { note('cal.collecting'); return state.calCollecting; },
      start(nowMs: number) { note(`cal.start:${nowMs}`); state.calCollecting = true; return false; },
      startFromPrimed(nowMs: number) { note(`cal.primed:${nowMs}`); state.calCollecting = true; return false; },
    },
    timingRuntime: {
      get contentValidationBaselineRevision() { note('timing.baseline-revision'); return state.baselineRevision; },
      clearContentValidationBaseline() { note('timing.clear'); state.baselineRevision = -1; },
      markContentValidationBaseline(revision: number) { note(`timing.mark:${revision}`); state.baselineRevision = revision; },
      autoCalibrationDue(nowMs: number) { note(`timing.due:${nowMs}`); return state.retryDue; },
      beginContentCalibration(nowMs: number, automatic: boolean) { note(`timing.begin:${nowMs}:${automatic}`); },
    },
    contentCalibrationValidator: {
      get hasBaseline() { note('validator.baseline'); return state.baseline; },
      get collecting() { note('validator.collecting'); return state.validatorCollecting; },
      status(nowMs: number) { note(`validator.status:${nowMs}`); return { state: state.validatorState }; },
      clearBaseline() {
        note('validator.clear'); state.baseline = false; state.validatorState = 'inactive';
        state.validatorCollecting = false; note('validator.publish:inactive');
      },
      setBaseline(value: ConfirmedContentCalibration, nowMs: number) {
        note(`validator.set:${nowMs}`); seeded = value; state.baseline = true;
        state.validatorState = 'waiting'; state.validatorCollecting = false;
        note('validator.publish:waiting');
      },
      cancel(nowMs: number) {
        note(`validator.cancel:${nowMs}`); state.validatorCollecting = false;
        state.validatorState = state.baseline ? 'waiting' : 'inactive';
        note(`validator.publish:${state.validatorState}`);
      },
      tick(nowMs: number) { note(`validator.tick:${nowMs}`); return true; },
      maybeStart(nowMs: number) { note(`validator.start:${nowMs}`); return true; },
    },
    backingRuntime: { connected() { note('backing.connected'); return state.backing; } },
    micRuntime: { controlConnected() { note('mic.control'); return state.micControl; } },
    calibrationContext() { note('context'); return context; },
    appliedCalibrationKind() { note('authority'); return state.kind; },
    calibrationIsStale() { note('stale'); return state.stale; },
    takeBlocksCalibration() { note('take'); return state.takeBlocked; },
    robotRouteActive() { note('route'); return state.route; },
    bootProbeSettled(nowMs: number) { note(`settled:${nowMs}`); return state.settled; },
    robotContentEvidenceMappingReady(nowMs: number) { note(`mapping:${nowMs}`); return state.mapping; },
    bothStreamsFlowing(nowMs: number) { note(`streams:${nowMs}`); return state.streams; },
    currentTimelineStatus(nowMs = performance.now()) {
      note(`timeline:${nowMs}`);
      return {
        get connected() { note('timeline.connected'); return state.timelineConnected; },
        get state() { note('timeline.state'); return state.timelineState; },
      };
    },
    probeCalibrationExhausted(nowMs: number) { note(`exhausted:${nowMs}`); return state.exhausted; },
    timingCalibrationStatusPayload() { note('timing.payload'); return { type: 'timing-calibration' }; },
    broadcastJson(payload: object) { note('timing.publish'); assert.deepEqual(payload, { type: 'timing-calibration' }); },
  };
  return { state, events, dependencies, workflow: workflowFromPorts(dependencies), seeded: () => seeded };
}

const baselineFacts = ['cal.confirmed', 'authority', 'stale', 'validator.baseline',
  'timing.baseline-revision', 'cal.revision'];

test('clear baseline withdraws metadata before the validator synchronous publication, even when already empty', () => {
  for (const baseline of [true, false]) {
    const f = fixture({ baseline });
    assert.equal(f.workflow.clearBaseline(), undefined);
    assert.deepEqual(f.events, ['timing.clear', 'validator.clear', 'validator.publish:inactive']);
    assert.equal(f.state.baselineRevision, -1);
    assert.equal(f.state.baseline, false);
  }
});

for (const [name, overrides, clear] of [
  ['retained Boot without existing baseline', { kind: 'boot-probe', baseline: false }, false],
  ['retained Boot with content baseline', { kind: 'boot-probe' }, true],
  ['stale content', { stale: true }, true],
  ['absent confirmed content', { result: null }, true],
  ['same confirmed revision', {}, false],
] as const) {
  test(`baseline synchronization: ${name}`, () => {
    const f = fixture(overrides);
    f.workflow.syncBaseline(9);
    const facts = f.state.result === null ? baselineFacts.filter(value => value !== 'stale') : baselineFacts;
    assert.deepEqual(f.events, [...facts, ...(clear ? ['timing.clear', 'validator.clear', 'validator.publish:inactive'] : [])]);
    assert.equal(f.seeded(), null);
  });
}

for (const baseline of [true, false]) {
  test(`new content revision seeds canonical context before revision mark, previous baseline=${baseline}`, () => {
    const f = fixture({ baseline, baselineRevision: 6 });
    f.workflow.syncBaseline(9);
    assert.deepEqual(f.events, [...baselineFacts, 'context', 'validator.set:9',
      'validator.publish:waiting', 'cal.revision', 'timing.mark:7']);
    assert.deepEqual(f.seeded(), { ...confirmed, context });
    assert.equal(f.state.baselineRevision, 7);
  });
}

for (const validatorState of ['inactive', 'waiting', 'collecting', 'suspect'] as const) {
  test(`cancel validation samples status before collecting, state=${validatorState}`, () => {
    const f = fixture({ validatorState, validatorCollecting: validatorState === 'collecting' });
    const changed = validatorState === 'collecting' || validatorState === 'suspect';
    assert.equal(f.workflow.cancelValidation(9), changed);
    assert.deepEqual(f.events, ['validator.status:9', 'validator.collecting',
      ...(changed ? ['validator.cancel:9', 'validator.publish:waiting'] : [])]);
  });
}

test('cancel validation retains its own default monotonic clock', () => {
  const f = fixture({ validatorState: 'suspect' });
  assert.equal(f.workflow.cancelValidation(), true);
  assert.deepEqual(f.events, ['clock', 'validator.status:701', 'validator.collecting',
    'validator.cancel:701', 'validator.publish:waiting']);
});

test('disabled automatic feature samples nothing, and Take rejects before route or authority', () => {
  const disabled = fixture({ autoEnabled: false });
  disabled.workflow.stepAuto(9);
  assert.deepEqual(disabled.events, []);
  const recording = fixture({ takeBlocked: true });
  recording.workflow.stepAuto(9);
  assert.deepEqual(recording.events, ['take']);
});

const autoPrerequisites = ['take', 'route', 'settled:9', 'mix.active', 'cal.collecting'];
const autoAuthorityAbsent = [...autoPrerequisites, 'cal.confirmed'];
const autoLive = ['timing.due:9', 'backing.connected', 'mic.control', 'streams:9',
  'clock', 'timeline:701', 'timeline.connected', 'timeline.state'];

for (const [name, overrides, sampled] of [
  ['retry not due', { retryDue: false }, 1],
  ['Backing absent', { backing: false }, 2],
  ['Mic control absent', { micControl: false }, 3],
  ['streams quiet', { streams: false }, 4],
  ['timeline disconnected', { timelineConnected: false }, 8],
  ['timeline paused', { timelineState: 2 }, 8],
] as const) {
  test(`automatic admission retains liveness short-circuit: ${name}`, () => {
    const f = fixture({ result: null, ...overrides });
    f.workflow.stepAuto(9);
    assert.deepEqual(f.events, [...autoAuthorityAbsent, ...autoLive.slice(0, sampled)]);
    assert.equal(f.state.calCollecting, false);
  });
}

for (const exhausted of [false, true]) {
  test(`automatic start chooses mode after begin and publishes despite domain false return, exhausted=${exhausted}`, () => {
    const f = fixture({ result: null, exhausted });
    f.workflow.stepAuto(9);
    assert.deepEqual(f.events, [...autoAuthorityAbsent, ...autoLive,
      'timing.begin:9:true', 'exhausted:9', exhausted ? 'cal.primed:9' : 'cal.start:9',
      'timing.payload', 'timing.publish']);
    assert.equal(f.state.revision, 7);
  });
}

test('fresh legacy content is terminal without sampling applied authority', () => {
  const f = fixture();
  f.workflow.stepAuto(9);
  assert.deepEqual(f.events, [...autoPrerequisites, 'cal.confirmed', 'stale']);
});

test('fresh Robot Boot remains replaceable without relabeling its retained confirmed revision', () => {
  const f = fixture({ route: true, kind: 'boot-probe' });
  f.workflow.stepAuto(9);
  assert.deepEqual(f.events, ['take', 'route', 'settled:9', 'mapping:9', 'mix.active', 'cal.collecting',
    'cal.confirmed', 'stale', 'authority', ...autoLive, 'timing.begin:9:true', 'exhausted:9',
    'cal.start:9', 'timing.payload', 'timing.publish']);
  assert.equal(f.state.kind, 'boot-probe');
  assert.equal(f.state.revision, 7);
});

const validationPrerequisites = ['route', 'take', 'settled:9', 'mix.active', 'cal.collecting'];
const validationAuthority = ['cal.confirmed', 'authority', 'stale'];
const validationLive = ['timeline:9', 'backing.connected', 'mic.control', 'streams:9',
  'timeline.connected', 'timeline.state'];

for (const overrides of [{ validationEnabled: false }, { takeBlocked: true }, { settled: false },
  { active: false }, { calCollecting: true }]) {
  test(`validation prerequisite failure retains eager facts but does not sample authority: ${JSON.stringify(overrides)}`, () => {
    const f = fixture(overrides);
    assert.equal(f.workflow.validationPathReady(9), false);
    assert.deepEqual(f.events, validationPrerequisites);
  });
}

test('validation live path samples timeline first, then all live facts even with disconnected Backing', () => {
  const f = fixture({ backing: false });
  assert.equal(f.workflow.validationPathReady(9), false);
  assert.deepEqual(f.events, [...validationPrerequisites, ...validationAuthority, ...validationLive]);
});

test('validation success calls tick then maybeStart without an assembly publication', () => {
  const f = fixture();
  assert.equal(f.workflow.stepValidation(9), undefined);
  assert.deepEqual(f.events, [...baselineFacts, 'validator.baseline', 'validator.status:9',
    ...validationPrerequisites, ...validationAuthority, ...validationLive,
    'validator.tick:9', 'validator.start:9']);
});

test('validation step still seeds baseline before Take-gated cancellation', () => {
  const f = fixture({ baseline: false, baselineRevision: 6, takeBlocked: true });
  f.workflow.stepValidation(9);
  assert.deepEqual(f.events, [...baselineFacts, 'context', 'validator.set:9', 'validator.publish:waiting',
    'cal.revision', 'timing.mark:7', 'validator.baseline', 'validator.status:9',
    ...validationPrerequisites, 'validator.collecting']);
});

test('metadata clear throw stops before validator command or publication', () => {
  const f = fixture({ throwAt: 'timing.clear' });
  assert.throws(() => f.workflow.clearBaseline(), /port threw at timing.clear/);
  assert.deepEqual(f.events, ['timing.clear']);
});

test('automatic begin throw stops before mode sampling, start and publication', () => {
  const f = fixture({ result: null, throwAt: 'timing.begin:9:true' });
  assert.throws(() => f.workflow.stepAuto(9), /port threw at timing.begin:9:true/);
  assert.deepEqual(f.events, [...autoAuthorityAbsent, ...autoLive, 'timing.begin:9:true']);
});

for (const overrides of [{ settled: false }, { active: false }, { calCollecting: true },
  { route: true, mapping: false }]) {
  test(`automatic prerequisite rejects without authority/liveness reads: ${JSON.stringify(overrides)}`, () => {
    const f = fixture(overrides);
    f.workflow.stepAuto(9);
    assert.deepEqual(f.events, f.state.route
      ? ['take', 'route', 'settled:9', 'mapping:9', 'mix.active', 'cal.collecting']
      : autoPrerequisites);
  });
}

test('fresh Robot content is terminal after the pure applied-authority query', () => {
  const f = fixture({ route: true });
  f.workflow.stepAuto(9);
  assert.deepEqual(f.events, ['take', 'route', 'settled:9', 'mapping:9', 'mix.active',
    'cal.collecting', 'cal.confirmed', 'stale', 'authority']);
});

test('stale Robot Boot may restart without sampling applied authority or changing confirmation', () => {
  const f = fixture({ route: true, kind: 'boot-probe', stale: true });
  f.workflow.stepAuto(9);
  assert.deepEqual(f.events, ['take', 'route', 'settled:9', 'mapping:9', 'mix.active',
    'cal.collecting', 'cal.confirmed', 'stale', ...autoLive, 'timing.begin:9:true',
    'exhausted:9', 'cal.start:9', 'timing.payload', 'timing.publish']);
  assert.equal(f.state.kind, 'boot-probe');
  assert.equal(f.state.revision, 7);
});

test('Robot validation samples evidence mapping before rejecting a pending reference boundary', () => {
  const f = fixture({ route: true, mapping: false });
  assert.equal(f.workflow.validationPathReady(9), false);
  assert.deepEqual(f.events, ['route', 'take', 'settled:9', 'mapping:9', 'mix.active', 'cal.collecting']);
});

for (const overrides of [{ kind: 'boot-probe' as const }, { kind: 'none' as const },
  { result: null }, { stale: true }]) {
  test(`validation rejects inapplicable authority without live reads: ${JSON.stringify(overrides)}`, () => {
    const f = fixture(overrides);
    assert.equal(f.workflow.validationPathReady(9), false);
    assert.deepEqual(f.events, [...validationPrerequisites, 'cal.confirmed', 'authority',
      ...(f.state.kind === 'content' && f.state.result !== null ? ['stale'] : [])]);
  });
}

for (const overrides of [{ micControl: false }, { streams: false }, { timelineConnected: false },
  { timelineState: 2 }]) {
  test(`validation preserves all eager live facts on rejection: ${JSON.stringify(overrides)}`, () => {
    const f = fixture(overrides);
    assert.equal(f.workflow.validationPathReady(9), false);
    assert.deepEqual(f.events, [...validationPrerequisites, ...validationAuthority, ...validationLive]);
  });
}

test('validation step revokes an old content baseline under retained Boot before reading status or path', () => {
  const f = fixture({ kind: 'boot-probe' });
  f.workflow.stepValidation(9);
  assert.deepEqual(f.events, [...baselineFacts, 'timing.clear', 'validator.clear',
    'validator.publish:inactive', 'validator.baseline']);
  assert.equal(f.state.baseline, false);
  assert.equal(f.state.revision, 7);
});

test('validation step with absent authority and absent baseline reads no status, path or metadata effects', () => {
  const f = fixture({ result: null, baseline: false });
  f.workflow.stepValidation(9);
  assert.deepEqual(f.events, ['cal.confirmed', 'authority', 'validator.baseline',
    'timing.baseline-revision', 'cal.revision', 'validator.baseline']);
});

for (const validatorState of ['inactive', 'waiting', 'collecting', 'suspect'] as const) {
  test(`validation path withdrawal cancels only collecting/suspect, state=${validatorState}`, () => {
    const f = fixture({ takeBlocked: true, validatorState,
      validatorCollecting: validatorState === 'collecting' });
    f.workflow.stepValidation(9);
    const changed = validatorState === 'collecting' || validatorState === 'suspect';
    assert.deepEqual(f.events, [...baselineFacts, 'validator.baseline', 'validator.status:9',
      ...validationPrerequisites, 'validator.collecting',
      ...(changed ? ['validator.cancel:9', 'validator.publish:waiting'] : [])]);
    assert.equal(f.state.baseline, true);
    assert.equal(f.state.revision, 7);
  });
}

test('synchronous baseline publication throw stops before confirmed-revision metadata mark', () => {
  const f = fixture({ baselineRevision: 6, throwAt: 'validator.publish:waiting' });
  assert.throws(() => f.workflow.syncBaseline(9), /port threw at validator.publish:waiting/);
  assert.deepEqual(f.events, [...baselineFacts, 'context', 'validator.set:9', 'validator.publish:waiting']);
  assert.equal(f.state.baselineRevision, 6);
});

test('validation tick throw does not fall through to maybeStart', () => {
  const f = fixture({ throwAt: 'validator.tick:9' });
  assert.throws(() => f.workflow.stepValidation(9), /port threw at validator.tick:9/);
  assert.deepEqual(f.events, [...baselineFacts, 'validator.baseline', 'validator.status:9',
    ...validationPrerequisites, ...validationAuthority, ...validationLive, 'validator.tick:9']);
});

test('automatic start throw occurs after begin/mode but prevents timing publication', () => {
  const f = fixture({ result: null, throwAt: 'cal.start:9' });
  assert.throws(() => f.workflow.stepAuto(9), /port threw at cal.start:9/);
  assert.deepEqual(f.events, [...autoAuthorityAbsent, ...autoLive,
    'timing.begin:9:true', 'exhausted:9', 'cal.start:9']);
});

test('automatic mode-query throw preserves begin and stops before calibration start', () => {
  const f = fixture({ result: null, throwAt: 'exhausted:9' });
  assert.throws(() => f.workflow.stepAuto(9), /port threw at exhausted:9/);
  assert.deepEqual(f.events, [...autoAuthorityAbsent, ...autoLive, 'timing.begin:9:true', 'exhausted:9']);
});

test('cancel status throw samples no collecting fact and issues no command', () => {
  const f = fixture({ throwAt: 'validator.status:9' });
  assert.throws(() => f.workflow.cancelValidation(9), /port threw at validator.status:9/);
  assert.deepEqual(f.events, ['validator.status:9']);
});

function analysisResult(lag: number): TimingCalibrationAnalysis {
  return { micLagMs: lag, confidence: 0.9, segmentLagsMs: [lag], segmentCorrelations: [0.9],
    micLevelDbfs: -20, backingLevelDbfs: -12 };
}
type Pending = { signal: AbortSignal | undefined;
  resolve(result: TimingCalibrationAnalysis): void; reject(error: unknown): void };
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

// Real domain owners and the production S22a applier. Only external liveness,
// capture rates, worker answers and the Take admission boundary are controlled.
// This fixture does not claim acoustic correlation or real storage admission.
function measuredFixture() {
  const f = fixture();
  const events: string[] = [];
  const control = { now: 0, micRate: 48_000, backingRate: 48_000,
    validationLag: 300, deferredValidation: false, deferredCalibration: true,
    takePhase: 'idle' as 'idle' | 'recording' | 'finalizing',
    backingConnected: true, micConnected: true, streams: true };
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
  const pendingValidation: Pending[] = [], pendingCalibration: Pending[] = [];
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
  const publications: Array<{ tag: string; revision: number; authorityRevision: number;
    authority: TimingCalibrationKind; lag: number | null; target: number | null;
    baselineRevision: number; validatorState: ContentValidationState; outcome: string | null }> = [];
  function publish(tag: string) {
    events.push(tag);
    const status = validator.status(control.now);
    publications.push({ tag, revision: calibration.confirmedRevision,
      authorityRevision: timing.authorityRevision, authority: timing.authorityKind,
      lag: mix.alignment.calibratedMicLagMs, target: mix.calibratedMicLagTarget,
      baselineRevision: timing.contentValidationBaselineRevision,
      validatorState: status.state, outcome: status.lastOutcome });
  }
  const calibration = new CalibrationSession({ sampleRate: 48_000, durationMs: 20,
    timeoutMs: 1_000, agreementWindows: 1, now: () => control.now, context: liveContext,
    analyze: (_mic, _backing, _rate, _maxLag, signal) => control.deferredCalibration
      ? new Promise<TimingCalibrationAnalysis>((resolve, reject) => pendingCalibration.push({ signal, resolve, reject }))
      : analysisResult(300),
    onSettled: () => {
      events.push('settled:authority');
      timing.syncConfirmedAuthority({ confirmedRevision: calibration.confirmedRevision,
        hasConfirmedResult: calibration.confirmedResult !== null });
      events.push('settled:mixer');
      applier.syncApplied();
      publish('settled:timing'); publish('settled:source');
    },
  });
  const validator = new ContentCalibrationValidator({ sampleRate: 48_000, durationMs: 20,
    timeoutMs: 1_000, intervalMs: 10, retryMs: 5, deviationThresholdMs: 10,
    agreementToleranceMs: 5, now: () => control.now, context: liveContext,
    analyze: (_mic, _backing, _rate, _maxLag, signal) => control.deferredValidation
      ? new Promise<TimingCalibrationAnalysis>((resolve, reject) => pendingValidation.push({ signal, resolve, reject }))
      : analysisResult(control.validationLag),
    onChange: () => publish('validator:timing'),
    onDriftConfirmed: result => {
      events.push('drift:mark'); timing.markContentAuthority();
      timing.prepareContentValidationSlew(calibration.confirmedRevision + 1);
      events.push(`drift:prepare:${calibration.confirmedRevision + 1}`);
      calibration.applyValidatedResult(result);
      timing.markContentValidationBaseline(calibration.confirmedRevision);
      events.push(`drift:baseline:${calibration.confirmedRevision}`);
    },
  });
  mapper.notePlayerOffset(100, liveContext(), 0, 1);
  probe.recordCalibration(bootContext(), { advanceMs: 240, micLatencyMs: 240,
    backingLatencyMs: 100, deltaMs: 100, confidence: 0.9 });
  const blocked = () => control.takePhase !== 'idle';
  const settled = () => probe.status(control.now).error !== null
    || (probe.pathDifferenceMs !== null && probe.completedContextMatches(bootContext()));
  const applier = createRelayCalibrationOrchestration({
    config: { reapplyThresholdMs: 20 }, clock: { now: () => control.now },
    mix, mic: { get sampleRate() { return control.micRate; } },
    backing: { get sampleRate() { return control.backingRate; } }, source, calibration,
    timing, probe, contentTimeline: mapper,
    queries: { takeBlocksCalibration: blocked, robotRouteActive: () => true,
      robotProbeTimingActive: () => true, bootProbeSettled: settled, bootProbeContext: bootContext,
      roomHasSong: () => true, robotDeltaIsFresh: () => true, robotDeltaEverEstablished: () => true,
      robotContentMappingReady: now => mapper.isReady(liveContext(), now),
      currentDeltaMs: () => 100, currentPlaybackRate: () => 1 },
  });
  const dependencies = { ...f.dependencies, session: mix, calibration, timingRuntime: timing,
    contentCalibrationValidator: validator, performance: { now: () => control.now },
    backingRuntime: { connected: () => control.backingConnected },
    micRuntime: { controlConnected: () => control.micConnected },
    calibrationContext: liveContext, appliedCalibrationKind: () => applier.appliedKind(),
    calibrationIsStale: () => applier.isStale(), takeBlocksCalibration: blocked,
    robotRouteActive: () => true, bootProbeSettled: settled,
    robotContentEvidenceMappingReady: (now: number) => mapper.isReady(liveContext(), now)
      && !mapper.needsBackingBoundary(liveContext()),
    bothStreamsFlowing: () => control.streams,
    currentTimelineStatus: () => ({ connected: true, state: 1 }),
    probeCalibrationExhausted: () => probe.status(control.now).error !== null,
    timingCalibrationStatusPayload: () => ({ type: 'timing-calibration' }),
    broadcastJson: () => publish('automatic:timing'),
  };
  const workflow = workflowFromPorts(dependencies);
  let validationSample = 0, calibrationSample = 0;
  function seedContent(lag = 240) {
    timing.markContentAuthority(); calibration.applyValidatedResult(analysisResult(lag));
  }
  function seedBoot() {
    timing.markBootProbeAuthority(); calibration.applyExternalResult({ micLagMs: 240, confidence: 0.9 });
  }
  function feedValidation() {
    const pcm = new Int16Array(960);
    validator.observeMic(pcm, validationSample); validator.observeBacking(pcm, validationSample);
    validationSample += pcm.length;
  }
  function feedCalibration() {
    const pcm = new Int16Array(960);
    calibration.observeMic(pcm, calibrationSample); calibration.observeBacking(pcm, calibrationSample);
    calibrationSample += pcm.length;
  }
  function startValidation() {
    workflow.syncBaseline(control.now); control.now += 10; workflow.stepValidation(control.now);
    assert.equal(validator.collecting, true); feedValidation();
  }
  return { control, events, publications, mix, source, timing, probe, mapper,
    calibration, validator, applier, workflow, pendingValidation, pendingCalibration,
    seedContent, seedBoot, feedValidation, feedCalibration, startValidation, ingestCaptures, liveContext };
}

test('real baseline seed publishes current validator truth before revision mark, without status-triggered synchronization', () => {
  const h = measuredFixture(); h.seedContent(); h.events.length = 0; h.publications.length = 0;
  h.workflow.syncBaseline(0);
  assert.deepEqual(h.events, ['validator:timing']);
  assert.equal(h.publications[0].validatorState, 'waiting');
  assert.equal(h.publications[0].baselineRevision, -1);
  assert.equal(h.publications[0].revision, 1);
  assert.equal(h.timing.contentValidationBaselineRevision, 1);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
  h.workflow.syncBaseline(0);
  assert.equal(h.publications.length, 1);
});

for (const readStatus of [false, true]) {
  test(`real two-window drift promotes once, prepares slew before settlement, status read=${readStatus}`, () => {
    const h = measuredFixture(); h.seedContent(); h.startValidation();
    assert.equal(h.validator.status(h.control.now).state, 'suspect');
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
    if (readStatus) { h.calibration.status(); h.applier.appliedKind(); h.applier.desiredLag(h.control.now); }
    h.events.length = 0; h.publications.length = 0; h.control.validationLag = 301;
    h.workflow.stepValidation(h.control.now); h.events.length = 0; h.publications.length = 0;
    h.feedValidation();
    assert.deepEqual(h.events, ['drift:mark', 'drift:prepare:2', 'settled:authority', 'settled:mixer',
      'settled:timing', 'settled:source', 'drift:baseline:2', 'validator:timing']);
    assert.equal(h.calibration.confirmedRevision, 2);
    assert.equal(h.timing.authorityRevision, 2);
    assert.equal(h.timing.authorityKind, 'content');
    assert.equal(h.timing.contentValidationBaselineRevision, 2);
    assert.equal(h.timing.contentValidationSlewRevision, null);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 240, 'the live read head does not snap to drift');
    assert.equal(h.mix.calibratedMicLagTarget, 301);
    assert.equal(h.validator.status(h.control.now).lastOutcome, 'drift-confirmed');
    assert.equal(h.applier.syncApplied(), false, 'repeat synchronization does not reissue the handed-off target');
    for (const publication of h.publications) {
      assert.equal(publication.revision, 2); assert.equal(publication.authorityRevision, 2);
      assert.equal(publication.target, 301); assert.equal(publication.validatorState, 'waiting');
      assert.equal(publication.outcome, 'drift-confirmed');
    }
  });
}

test('real candidate content leaves retained Boot serving and never seeds a content validator baseline', () => {
  const h = measuredFixture(); h.seedBoot();
  const previous = h.calibration.confirmedResult;
  h.workflow.stepAuto(0);
  assert.equal(h.calibration.collecting, true);
  assert.equal(h.timing.calibrationKind, 'content');
  assert.equal(h.timing.authorityKind, 'boot-probe');
  h.workflow.syncBaseline(0);
  assert.equal(h.validator.hasBaseline, false);
  assert.equal(h.timing.contentValidationBaselineRevision, -1);
  assert.deepEqual(h.calibration.confirmedResult, previous);
  assert.equal(h.calibration.confirmedRevision, 1);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
});

type Measured = ReturnType<typeof measuredFixture>;
const interruptions: Array<{ name: string; run(h: Measured): void; revision: number; lag: number | null }> = [
  { name: 'explicit clear', run: h => h.workflow.clearBaseline(), revision: 1, lag: 240 },
  { name: 'explicit cancel', run: h => { assert.equal(h.workflow.cancelValidation(h.control.now), true); }, revision: 1, lag: 240 },
  { name: 'confirmed successor reseed', run: h => { h.seedContent(300); h.workflow.syncBaseline(h.control.now); }, revision: 2, lag: 300 },
  { name: 'session generation', run: h => { h.mix.stop(); h.mix.start(h.control.now); h.ingestCaptures(); }, revision: 1, lag: null },
  { name: 'Mic generation', run: h => {
    h.mix.ingestMic({ generation: 20, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, h.control.micRate, h.control.now);
  }, revision: 1, lag: null },
  { name: 'Backing generation', run: h => {
    h.mix.ingestBacking({ generation: 30, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, h.control.backingRate, h.control.now);
  }, revision: 1, lag: null },
  { name: 'Source generation', run: h => { h.source.invalidateMapping(); }, revision: 1, lag: null },
  { name: 'Mic rate only', run: h => { h.control.micRate = 44_100; }, revision: 1, lag: null },
  { name: 'Backing rate only', run: h => { h.control.backingRate = 44_100; }, revision: 1, lag: null },
  { name: 'PCM flow readiness withdrawn', run: h => {
    h.control.streams = false; h.workflow.stepValidation(h.control.now);
    assert.equal(h.validator.hasBaseline, true);
    assert.equal(h.validator.status(h.control.now).state, 'waiting');
    assert.equal(h.validator.status(h.control.now).lastOutcome, null);
  }, revision: 1, lag: 240 },
];

function realTruth(h: Measured) {
  return { confirmed: h.calibration.confirmedResult, revision: h.calibration.confirmedRevision,
    authorityRevision: h.timing.authorityRevision, authority: h.timing.authorityKind,
    alignment: h.mix.alignment.calibratedMicLagMs, target: h.mix.calibratedMicLagTarget,
    baselineRevision: h.timing.contentValidationBaselineRevision,
    slewRevision: h.timing.contentValidationSlewRevision, validator: h.validator.status(h.control.now),
    publications: h.publications.slice(), events: h.events.slice() };
}

for (const interruption of interruptions) for (const completion of ['resolve', 'reject'] as const) {
  test(`real old validation worker ${completion} after ${interruption.name} cannot republish or promote`, async () => {
    const h = measuredFixture(); h.seedContent(); h.control.deferredValidation = true; h.startValidation();
    assert.equal(h.pendingValidation.length, 1);
    const old = h.pendingValidation[0];
    assert.equal(old.signal?.aborted, false);
    interruption.run(h);
    if (interruption.lag === null) {
      assert.equal(h.applier.isStale(), true, 'the actual generation/rate context changed');
      h.workflow.stepValidation(h.control.now);
      h.applier.syncApplied();
      assert.equal(h.validator.hasBaseline, false);
    }
    assert.equal(old.signal?.aborted, true);
    assert.equal(h.calibration.confirmedRevision, interruption.revision);
    assert.equal(h.timing.authorityRevision, interruption.revision);
    assert.equal(h.mix.alignment.calibratedMicLagMs, interruption.lag);
    const before = realTruth(h);
    if (completion === 'resolve') old.resolve(analysisResult(399));
    else old.reject(new Error('old analysis rejection'));
    await nextTurn();
    assert.deepEqual(realTruth(h), before);
  });
}

for (const interruption of interruptions.slice(0, 3)) for (const completion of ['resolve', 'reject'] as const) {
  test(`real old validation ${completion} after ${interruption.name} leaves a new worker authoritative`, async () => {
    const h = measuredFixture(); h.seedContent(); h.control.deferredValidation = true; h.startValidation();
    const old = h.pendingValidation[0]; interruption.run(h);
    h.workflow.syncBaseline(h.control.now);
    h.control.now += 20; h.workflow.stepValidation(h.control.now); h.feedValidation();
    assert.equal(h.pendingValidation.length, 2);
    const current = h.pendingValidation[1];
    assert.equal(old.signal?.aborted, true); assert.equal(current.signal?.aborted, false);
    assert.equal(h.validator.collecting, true);
    const before = realTruth(h);
    if (completion === 'resolve') old.resolve(analysisResult(399));
    else old.reject(new Error('old analysis rejection'));
    await nextTurn();
    assert.deepEqual(realTruth(h), before);
    assert.equal(current.signal?.aborted, false);
    current.resolve(analysisResult(interruption.revision === 2 ? 305 : 245));
    await nextTurn();
    assert.equal(h.validator.status(h.control.now).lastOutcome, 'stable');
    assert.equal(h.calibration.confirmedRevision, interruption.revision);
    assert.equal(h.mix.alignment.calibratedMicLagMs, interruption.lag);
  });
}

for (const admitted of [false, true]) for (const mode of ['validation', 'content'] as const) {
  for (const completion of ['resolve', 'reject'] as const) {
    test(`real Take coordinator controlled admission=${admitted}, ${mode} pending worker ${completion}`, async () => {
      const h = measuredFixture(); h.seedContent(); h.workflow.syncBaseline(0);
      let pending: Pending;
      if (mode === 'validation') {
        h.control.deferredValidation = true; h.startValidation(); pending = h.pendingValidation[0];
      } else {
        h.timing.beginContentCalibration(0, false); h.calibration.start(0); h.feedCalibration();
        pending = h.pendingCalibration[0];
      }
      assert.ok(pending); assert.equal(pending.signal?.aborted, false);
      const commandTrace: string[] = [];
      const coordinator = createRelayTakeCommandCoordinator({
        frameBoundary: () => { commandTrace.push('boundary'); return { atMs: h.control.now, position: 0 }; },
        songSnapshot: () => { commandTrace.push('song'); return null; },
        startTake: () => {
          commandTrace.push('start');
          if (!admitted) return { ok: false as const, reason: 'take-active' };
          h.control.takePhase = 'recording'; return { ok: true as const, takeId: 'fixture-take' };
        },
        cancelActiveContentValidation: now => { commandTrace.push('cancel'); return h.workflow.cancelValidation(now); },
        standDownContentCalibration: () => { commandTrace.push('stand-down'); return h.calibration.abandon(); },
        reportTimingStatus: () => { commandTrace.push('report'); },
        stopTake: () => ({ ok: false as const, reason: 'unused' }),
        reject: () => { commandTrace.push('reject'); },
        acceptStart: () => { commandTrace.push('accept'); }, acceptStop: () => {},
      });
      assert.equal(coordinator.start({ socket: {}, participantId: 'fixture',
        commandWallClockMs: 1_000, nowMs: h.control.now }), admitted);
      assert.deepEqual(commandTrace, admitted
        ? ['boundary', 'song', 'start', 'cancel', ...(mode === 'validation' ? ['report'] : []),
          'stand-down', ...(mode === 'content' ? ['report'] : []), 'accept']
        : ['boundary', 'song', 'start', 'reject']);
      assert.equal(pending.signal?.aborted, admitted);
      assert.equal(h.calibration.confirmedRevision, 1);
      assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
      const before = realTruth(h);
      if (completion === 'resolve') pending.resolve(analysisResult(300));
      else pending.reject(new Error('old analysis rejection'));
      await nextTurn();
      if (admitted) {
        assert.deepEqual(realTruth(h), before);
        assert.equal(h.calibration.status().error, null, 'standing down is not measurement failure');
      } else if (mode === 'validation') {
        assert.equal(h.validator.status(h.control.now).lastOutcome, completion === 'resolve' ? 'suspect' : 'invalid');
        assert.equal(h.calibration.confirmedRevision, 1);
        if (completion === 'resolve') {
          h.control.deferredValidation = false; h.control.validationLag = 301;
          h.workflow.stepValidation(h.control.now); h.feedValidation();
          assert.equal(h.calibration.confirmedRevision, 2);
          assert.equal(h.mix.calibratedMicLagTarget, 301, 'rejected Take did not discard the first confirmation window');
        }
      } else {
        assert.equal(h.calibration.confirmedRevision, completion === 'resolve' ? 2 : 1);
        assert.equal(h.mix.alignment.calibratedMicLagMs, completion === 'resolve' ? 300 : 240);
      }
    });
  }
}

test('real exhausted preferred Boot hands primed PCM to automatic content without re-collecting or losing retained authority', async () => {
  const h = measuredFixture(); h.seedBoot();
  const previous = h.calibration.confirmedResult;
  const bootResult = h.probe.calibrationResult;
  h.calibration.beginExternalRecalibration(); h.timing.beginBootProbe(false); h.probe.abandonRun();
  const pcm = new Int16Array(960);
  h.calibration.primeMic(pcm, 0); h.calibration.primeBacking(pcm, 0);
  assert.equal(h.pendingCalibration.length, 0, 'primed PCM is not measurement authority');
  const requestId = h.probe.nextRequestId();
  assert.equal(h.probe.beginRequest({ target: 'mic', requestId, serverSentAtMs: 0,
    sessionGeneration: h.mix.generation, generation: h.mix.micGeneration! }), true);
  const failure = createRelayBootProbeFailureSettlementCoordinator({
    restoreCandidateKindToAuthority: () => h.timing.restoreCandidateKindToAuthority(),
    failPreservingPrimed: message => h.calibration.failPreservingPrimed(message),
    reportTimingStatus: () => {},
  });
  assert.equal(failure.settle(h.probe.failAttempt('mic', 'bounded fixture exhaustion', 0)), 'terminal');
  assert.notEqual(h.probe.status(0).error, null);
  assert.deepEqual(h.calibration.confirmedResult, previous);
  h.workflow.stepAuto(0);
  assert.equal(h.pendingCalibration.length, 1, 'startFromPrimed analyzes the already complete window');
  assert.equal(h.calibration.collecting, true);
  assert.equal(h.timing.calibrationKind, 'content');
  assert.equal(h.timing.authorityKind, 'boot-probe');
  assert.equal(h.calibration.confirmedRevision, 1);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
  h.pendingCalibration[0].resolve(analysisResult(300)); await nextTurn();
  assert.equal(h.calibration.confirmedRevision, 2);
  assert.equal(h.timing.authorityRevision, 2);
  assert.equal(h.timing.authorityKind, 'content');
  assert.equal(h.mix.alignment.calibratedMicLagMs, 300);
  assert.deepEqual(h.probe.calibrationResult, bootResult, 'fallback measurement is retained independently');
  h.workflow.syncBaseline(0);
  assert.equal(h.validator.hasBaseline, true);
  assert.equal(h.validator.status(0).baselineLagMs, 300);
  assert.equal(h.timing.contentValidationBaselineRevision, 2);
});

for (const phase of ['recording', 'finalizing'] as const) {
  test(`real ${phase} Take prevents automatic work and cancels suspect validation without moving alignment`, () => {
    const h = measuredFixture(); h.seedContent(); h.startValidation();
    assert.equal(h.validator.status(h.control.now).state, 'suspect');
    h.control.takePhase = phase; h.events.length = 0; h.publications.length = 0;
    h.workflow.stepAuto(h.control.now); h.workflow.stepValidation(h.control.now);
    assert.deepEqual(h.events, ['validator:timing']);
    assert.equal(h.calibration.collecting, false);
    assert.equal(h.validator.status(h.control.now).state, 'waiting');
    assert.equal(h.validator.hasBaseline, true);
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.applier.syncApplied(), false);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
    assert.equal(h.mix.calibratedMicLagTarget, 240);
  });
}
