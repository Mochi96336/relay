import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { BootProbeRuntime, type BootProbeContext } from '../src/boot-probe-runtime.js';
import type { CalibrationAuthorityKind } from '../src/calibration-applicability.js';
import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import { createRelayBootProbeFailureSettlementCoordinator } from '../src/relay-boot-probe-failure-settlement-coordinator.js';
import { createRelayCalibrationOrchestration, type RelayCalibrationDependencies } from '../src/relay-calibration-orchestration.js';
import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';
import { SourceRuntime } from '../src/source-runtime.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';
import { TimingRuntime } from '../src/timing-runtime.js';
import { functionCode, hasFunction, importSources, objectArrowCallbackCode, parseTypeScriptSource, sourceCode, variableInitializerCode } from './support/source-contract.js';

type Workflow = {
  context(): CalibrationContext;
  isStale(): boolean;
  appliedKind(): CalibrationAuthorityKind;
  applicability(kind?: CalibrationAuthorityKind): 'apply' | 'hold' | 'revoke';
  bootAdvance(nowMs: number): number | null;
  contentLiveLag(referenceLagMs: number, nowMs: number): number | null;
  desiredLag(nowMs: number): number | null;
  syncApplied(): boolean;
};

const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
const entryPoints = [
  ['calibrationContext', 'context', '()'],
  ['calibrationIsStale', 'isStale', '()'],
  ['appliedCalibrationKind', 'appliedKind', '()'],
  ['calibrationApplicability', 'applicability', '(kind)'],
  ['bootProbeAdvanceMs', 'bootAdvance', '(nowMs)'],
  ['desiredCalibratedMicLagMs', 'desiredLag', '(nowMs)'],
  ['syncAppliedCalibration', 'syncApplied', '()'],
] as const;

test('production calibration binds one canonical assembly after all owners and before asynchronous start', () => {
  assert.equal(importSources(server).filter(path => path === './relay-calibration-orchestration.js').length, 1);
  const construction = variableInitializerCode(server, 'relayCalibration');
  assert.equal(construction.replace(/\s/g, ''), `createRelayCalibrationOrchestration({
    config: { reapplyThresholdMs: BOOT_DELTA_REAPPLY_MS }, clock: performance,
    mix: session, mic: micRuntime, backing: backingRuntime, source: sourceRuntime,
    calibration, timing: timingRuntime, probe: bootProbeRuntime, contentTimeline: robotContentTimeline,
    queries: { takeBlocksCalibration, robotRouteActive, robotProbeTimingActive, bootProbeSettled,
      bootProbeContext, roomHasSong, robotDeltaIsFresh, robotDeltaEverEstablished,
      robotContentMappingReady, currentDeltaMs, currentPlaybackRate, },
  })`.replace(/\s/g, ''));
  const code = sourceCode(server);
  assert.equal(Array.from(code.matchAll(/createRelayCalibrationOrchestration\(/g)).length, 1);
  const index = code.indexOf('const relayCalibration =');
  for (const name of ['session', 'micRuntime', 'backingRuntime', 'sourceRuntime', 'calibration',
    'timingRuntime', 'bootProbeRuntime', 'robotContentTimeline', 'contentCalibrationValidator']) {
    const owner = code.indexOf(`const ${name} =`);
    assert.ok(owner >= 0 && owner < index, `${name} constructed before inert composition`);
  }
  assert.doesNotMatch(code.slice(0, index), /\bawait\b/);
  assert.ok(index < code.indexOf('relayMixPump.start();'));
  assert.ok(index < code.indexOf('const youtubeTimelineTimer ='));
  for (const owner of ['calibration', 'contentCalibrationValidator']) {
    assert.match(variableInitializerCode(server, owner), /context: calibrationContext/);
  }
});

test('all seven live production calibration entries delegate exactly once without retaining algorithms or dead seams', () => {
  for (const [name, method, args] of entryPoints) {
    const code = functionCode(server, name);
    const body = code.slice(code.indexOf('{') + 1, code.lastIndexOf('}')).trim();
    assert.equal(body, `return relayCalibration.${method}${args};`, name);
  }
  assert.match(functionCode(server, 'calibrationApplicability'), /kind = appliedCalibrationKind\(\)/);
  assert.equal(hasFunction(server, 'contentLiveLagMs'), false, 'both original callers moved together into the new owner');
  assert.doesNotMatch(sourceCode(server), /decideCalibrationApplicability\(|decideCalibrationMixerApplication\(|decideBootProbeMixerApplication\(|mediaToWallMs\(/);
});

// Execute only the actual server's forwarding seams, stripping their declared
// TypeScript annotations. Algorithms always execute through the public factory.
function productionEntries(owner: Workflow): Omit<Workflow, 'contentLiveLag'> {
  const declarations = entryPoints.map(([name]) => functionCode(server, name)
    .replace(': CalibrationContext', '')
    .replace(': CalibrationApplicability', '')
    .replace('): number | null', ')')
    .replaceAll(': number', ''));
  const result = entryPoints.map(([name, method]) => `${method}: ${name}`).join(',');
  return new Function('relayCalibration', `${declarations.join('\n')}\nreturn {${result}};`)(owner) as Omit<Workflow, 'contentLiveLag'>;
}

test('actual forwarding seams preserve default kind, clocks, return values and full owner effect traces', () => {
  const calls: Array<[keyof Omit<Workflow, 'contentLiveLag'>, unknown[]]> = [
    ['context', []], ['isStale', []], ['appliedKind', []],
    ['applicability', []], ['applicability', [undefined]], ['applicability', ['content']],
    ['bootAdvance', [9]], ['desiredLag', [9]], ['syncApplied', []],
  ];
  for (const robot of [false, true]) for (const kind of ['content', 'boot-probe'] as const) {
    for (const [method, args] of calls) {
      const direct = fixture(), forwarded = fixture();
      Object.assign(direct.state, { route: robot, kind });
      Object.assign(forwarded.state, { route: robot, kind });
      const entries = productionEntries(forwarded.workflow);
      assert.deepEqual(Reflect.apply(entries[method], undefined, args),
        Reflect.apply(direct.workflow[method], undefined, args), `${robot}/${kind}/${method}`);
      assert.deepEqual(forwarded.events, direct.events, `${method}: default/clock/getter/effect order`);
      assert.deepEqual(forwarded.state, direct.state, `${method}: no extra mutation`);
    }
  }
});

test('calibration settlement and periodic application retain their original publication ownership and order', () => {
  const settlement = objectArrowCallbackCode(server, 'calibration', 'onSettled');
  const markers = ['timingRuntime.syncConfirmedAuthority({', 'syncAppliedCalibration();',
    'broadcastJson(timingCalibrationStatusPayload());', 'broadcastJson(sourceStatusPayload());'];
  let previous = -1;
  for (const marker of markers) {
    const index = settlement.indexOf(marker);
    assert.ok(index > previous, `${marker} remains ordered in synchronous settlement`);
    previous = index;
  }
  const tick = variableInitializerCode(server, 'youtubeTimelineTimer');
  assert.match(tick, /dropLegacyCalibrationForRobot\(\);\s*if \(syncAppliedCalibration\(\)\) \{\s*broadcastJson\(sourceStatusPayload\(\)\);\s*broadcastJson\(timingCalibrationStatusPayload\(\)\);\s*\}\s*maybeFinishProbeAnalysis\(nowMs\)/);
  assert.equal(Array.from(tick.matchAll(/syncAppliedCalibration\(\)/g)).length, 1);
});

type WorkflowInput = RelayCalibrationDependencies['queries'] & {
  session: RelayCalibrationDependencies['mix'];
  micRuntime: RelayCalibrationDependencies['mic'];
  backingRuntime: RelayCalibrationDependencies['backing'];
  sourceRuntime: RelayCalibrationDependencies['source'];
  calibration: RelayCalibrationDependencies['calibration'];
  timingRuntime: RelayCalibrationDependencies['timing'];
  bootProbeRuntime: RelayCalibrationDependencies['probe'];
  robotContentTimeline: RelayCalibrationDependencies['contentTimeline'];
  performance: RelayCalibrationDependencies['clock'];
  BOOT_DELTA_REAPPLY_MS: number;
};

// C0's original body adapter and fixed oracles are archived. Only this entry
// changes to the new public factory; the expected behaviour remains untouched.
function workflowFromPorts(d: WorkflowInput): Workflow {
  return createRelayCalibrationOrchestration({
    config: { reapplyThresholdMs: d.BOOT_DELTA_REAPPLY_MS }, clock: d.performance,
    mix: d.session, mic: d.micRuntime, backing: d.backingRuntime, source: d.sourceRuntime,
    calibration: d.calibration, timing: d.timingRuntime, probe: d.bootProbeRuntime,
    contentTimeline: d.robotContentTimeline,
    queries: { takeBlocksCalibration: d.takeBlocksCalibration,
      robotRouteActive: d.robotRouteActive, robotProbeTimingActive: d.robotProbeTimingActive,
      bootProbeSettled: d.bootProbeSettled, bootProbeContext: d.bootProbeContext,
      roomHasSong: d.roomHasSong, robotDeltaIsFresh: d.robotDeltaIsFresh,
      robotDeltaEverEstablished: d.robotDeltaEverEstablished,
      robotContentMappingReady: d.robotContentMappingReady,
      currentDeltaMs: d.currentDeltaMs, currentPlaybackRate: d.currentPlaybackRate },
  });
}

function fixture() {
  const events: string[] = [];
  const state = {
    kind: 'content' as CalibrationAuthorityKind, provisional: false,
    result: { micLagMs: 250, confidence: 0.9 } as { micLagMs: number; confidence: number } | null,
    stale: false, transaction: false, route: false, strategy: false, settled: true,
    sourceConnected: true, song: true, fresh: true, established: true, mapping: true,
    path: 150 as number | null, delta: 100, rate: 2, completed: true,
    active: null as number | null, target: null as number | null,
    slewRevision: null as number | null, slewReturn: true,
    takePhase: 'idle' as 'idle' | 'recording' | 'finalizing',
    storedDelta: 100 as number | null, mappingOffset: 25 as number | null,
    throwAt: null as string | null,
  };
  let clock = 100;
  const note = (event: string) => {
    events.push(event);
    if (state.throwAt === event) throw new Error(`port threw at ${event}`);
  };
  const session = {
    get generation() { note('mix.generation'); return 1; },
    get micGeneration() { note('mix.mic-generation'); return 2; },
    get backingGeneration() { note('mix.backing-generation'); return 3; },
    get alignment() { note('mix.alignment'); return { calibratedMicLagMs: state.active }; },
    get calibratedMicLagTarget() { note('mix.target'); return state.target; },
    setAlignment(input: { calibratedMicLagMs: number | null }) {
      note(`mix.set:${input.calibratedMicLagMs}`); state.active = input.calibratedMicLagMs;
    },
    slewCalibratedMicLagTo(lag: number) { note(`mix.slew:${lag}`); return state.slewReturn; },
  };
  const micRuntime = { get sampleRate() { note('mic.rate'); return 48_000; } };
  const backingRuntime = { get sampleRate() { note('backing.rate'); return 44_100; } };
  const sourceRuntime = {
    get generation() { note('source.generation'); return 4; },
    connected() { note('source.connected'); return state.sourceConnected; },
  };
  const calibration = {
    get result() { note('cal.result'); return state.result; },
    get confirmedResult() { note('cal.confirmed'); return state.result; },
    get confirmedRevision() { note('cal.revision'); return 7; },
    get transactionActive() { note('cal.transaction'); return state.transaction; },
    status() { note('cal.status'); return { provisional: state.provisional }; },
    isStaleFor(context: CalibrationContext) {
      note('cal.stale'); assert.deepEqual(context, expectedContext); return state.stale;
    },
  };
  const timingRuntime = {
    appliedCalibrationKind(input: { hasConfirmedResult: boolean; provisional: boolean }) {
      note(`timing.applied:${input.hasConfirmedResult}:${input.provisional}`); return state.kind;
    },
    get contentValidationSlewRevision() { note('timing.slew-revision'); return state.slewRevision; },
    contentValidationSlewMatches(revision: number) { note(`timing.slew-matches:${revision}`); return state.slewRevision === revision; },
    clearContentValidationSlew() { note('timing.clear-slew'); state.slewRevision = null; },
  };
  const bootProbeRuntime = {
    get pathDifferenceMs() { note('probe.path'); return state.path; },
    get calibrationResult() { note('probe.result'); return state.storedDelta === null ? null : { deltaMs: state.storedDelta }; },
    completedContextMatches(_context: object) { note('probe.completed'); return state.completed; },
  };
  const dependencies = {
    session, micRuntime, backingRuntime, sourceRuntime, calibration, timingRuntime, bootProbeRuntime,
    robotContentTimeline: { liveLagMs(reference: number, context: CalibrationContext, nowMs: number) {
      note(`timeline.live:${reference}:${nowMs}`); assert.deepEqual(context, expectedContext);
      return state.mappingOffset === null ? null : reference + state.mappingOffset;
    } },
    performance: { now() { clock += 1; note(`clock:${clock}`); return clock; } },
    takeBlocksCalibration() { note('take.blocked'); return state.takePhase !== 'idle'; },
    robotRouteActive() { note('robot.route'); return state.route; },
    robotProbeTimingActive() { note('probe.strategy'); return state.strategy; },
    bootProbeSettled(nowMs: number) { note(`probe.settled:${nowMs}`); return state.settled; },
    bootProbeContext() {
      note('probe.context');
      return { sessionGeneration: 1, micGeneration: 2, backingGeneration: 3,
        micSourceRate: 48_000, backingSourceRate: 44_100 };
    },
    roomHasSong(nowMs: number) { note(`room.song:${nowMs}`); return state.song; },
    robotDeltaIsFresh(nowMs: number) { note(`robot.fresh:${nowMs}`); return state.fresh; },
    robotDeltaEverEstablished() { note('robot.established'); return state.established; },
    robotContentMappingReady(nowMs: number) { note(`robot.mapping:${nowMs}`); return state.mapping; },
    currentDeltaMs(nowMs: number) { note(`delta:${nowMs}`); return state.delta; },
    currentPlaybackRate(nowMs: number) { note(`rate:${nowMs}`); return state.rate; },
    BOOT_DELTA_REAPPLY_MS: 20,
  };
  return { events, state, dependencies, workflow: workflowFromPorts(dependencies) };
}

const expectedContext: CalibrationContext = {
  sessionGeneration: 1, micGeneration: 2, backingGeneration: 3,
  micSourceRate: 48_000, backingSourceRate: 44_100, sourceGeneration: 4,
};
const contextTrace = ['mix.generation', 'mix.mic-generation', 'mix.backing-generation',
  'mic.rate', 'backing.rate', 'source.generation'];

test('calibration factory construction reads no owner, query or clock and exposes exactly its eight entry points', () => {
  const f = fixture();
  const poison = <T extends object>(owner: T): T => new Proxy(owner, {
    get(_target, property) { throw new Error(`constructor queried ${String(property)}`); },
  });
  const owner = createRelayCalibrationOrchestration({
    config: { reapplyThresholdMs: 20 }, clock: poison(f.dependencies.performance),
    mix: poison(f.dependencies.session), mic: poison(f.dependencies.micRuntime),
    backing: poison(f.dependencies.backingRuntime), source: poison(f.dependencies.sourceRuntime),
    calibration: poison(f.dependencies.calibration), timing: poison(f.dependencies.timingRuntime),
    probe: poison(f.dependencies.bootProbeRuntime), contentTimeline: poison(f.dependencies.robotContentTimeline),
    queries: poison(f.dependencies),
  });
  assert.deepEqual(Object.keys(owner).sort(), ['applicability', 'appliedKind', 'bootAdvance',
    'contentLiveLag', 'context', 'desiredLag', 'isStale', 'syncApplied']);
  assert.deepEqual(f.events, []);
  assert.equal(f.state.active, null);
  assert.equal(f.state.slewRevision, null);
});

test('calibration assembly adds no scheduler, async boundary, publication or second domain owner', () => {
  const workflow = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(sourceCode(workflow), /\b(?:setInterval|setTimeout|queueMicrotask|async|await)\b|new (?:AudioSession|CalibrationSession|TimingRuntime|BootProbeRuntime|RobotContentTimelineMapper|Map|WeakMap)\b/);
  assert.doesNotMatch(sourceCode(workflow), /syncConfirmedAuthority\(|broadcastJson\(/);
});

test('calibration context reads all canonical generations and source rates in the original order', () => {
  const f = fixture();
  assert.deepEqual(f.workflow.context(), expectedContext);
  assert.deepEqual(f.events, contextTrace);
});

test('staleness reads the current whole context before asking the calibration owner', () => {
  const f = fixture(); f.state.stale = true;
  assert.equal(f.workflow.isStale(), true);
  assert.deepEqual(f.events, [...contextTrace, 'cal.stale']);
});

test('applied provenance delegates confirmed and provisional facts without reading candidate strategy', () => {
  const f = fixture(); f.state.provisional = true;
  assert.equal(f.workflow.appliedKind(), 'content');
  assert.deepEqual(f.events, ['cal.status', 'cal.confirmed', 'timing.applied:true:true']);
});

test('an explicit applicability kind preserves all live facts and the original monotonic sample', () => {
  const f = fixture();
  assert.equal(f.workflow.applicability('content'), 'apply');
  assert.deepEqual(f.events, ['clock:101', 'cal.result', 'cal.status', ...contextTrace,
    'cal.stale', 'cal.transaction', 'cal.confirmed', 'probe.strategy', 'probe.settled:101',
    'robot.route', 'source.connected', 'room.song:101', 'robot.fresh:101',
    'robot.established', 'robot.mapping:101']);
});

test('default applicability resolves applied provenance before taking its own clock and facts', () => {
  const f = fixture(); f.state.result = null;
  assert.equal(f.workflow.applicability(), 'revoke');
  assert.deepEqual(f.events, ['cal.status', 'cal.confirmed', 'timing.applied:false:false',
    'clock:101', 'cal.result', 'cal.status', 'cal.transaction', 'cal.confirmed',
    'probe.strategy', 'probe.settled:101', 'robot.route', 'source.connected', 'room.song:101',
    'robot.fresh:101', 'robot.established', 'robot.mapping:101']);
});

test('boot advance converts media delta through playback rate without taking another clock', () => {
  const f = fixture();
  assert.equal(f.workflow.bootAdvance(7), 200);
  assert.deepEqual(f.events, ['probe.path', 'delta:7', 'rate:7']);
});

test('missing boot path returns before reading the delta or rate', () => {
  const f = fixture(); f.state.path = null;
  assert.equal(f.workflow.bootAdvance(7), null);
  assert.deepEqual(f.events, ['probe.path']);
});

test('content live lag delegates reference coordinates with the fresh whole context and caller clock', () => {
  const f = fixture();
  assert.equal(f.workflow.contentLiveLag(250, 9), 275);
  assert.deepEqual(f.events, [...contextTrace, 'timeline.live:250:9']);
});

type State = ReturnType<typeof fixture>['state'];
const appliedTrace = ['cal.status', 'cal.confirmed', 'timing.applied:true:false'];
function applicabilityTrace(nowMs: number) {
  return [`clock:${nowMs}`, 'cal.result', 'cal.status', ...contextTrace, 'cal.stale',
    'cal.transaction', 'cal.confirmed', 'probe.strategy', `probe.settled:${nowMs}`,
    'robot.route', 'source.connected', `room.song:${nowMs}`, `robot.fresh:${nowMs}`,
    'robot.established', `robot.mapping:${nowMs}`];
}
function mutations(events: string[]) {
  return events.filter(event => event === 'timing.clear-slew' || /^mix\.(?:set|slew):/.test(event));
}

const applicabilityCases: { name: string; patch: Partial<State>; expected: 'apply' | 'hold' | 'revoke' }[] = [
  { name: 'missing result', patch: { result: null }, expected: 'revoke' },
  { name: 'stale retained result', patch: { stale: true }, expected: 'revoke' },
  { name: 'unsettled boot preferred over unconfirmed content', patch: { strategy: true, settled: false }, expected: 'revoke' },
  { name: 'replacement transaction retains confirmed content', patch: { strategy: true, settled: false, transaction: true }, expected: 'apply' },
  { name: 'provisional content does not inherit retained exception', patch: { strategy: true, settled: false, transaction: true, provisional: true }, expected: 'revoke' },
  { name: 'physical Robot source gone even with strategy disabled', patch: { route: true, sourceConnected: false }, expected: 'revoke' },
  { name: 'established content mapping temporarily quiet', patch: { route: true, mapping: false }, expected: 'hold' },
  { name: 'content mapping never established', patch: { route: true, mapping: false, established: false }, expected: 'revoke' },
  { name: 'boot delta temporarily quiet', patch: { kind: 'boot-probe', route: true, fresh: false }, expected: 'hold' },
  { name: 'boot delta never established', patch: { kind: 'boot-probe', route: true, fresh: false, established: false }, expected: 'revoke' },
  { name: 'boot with no Song needs no fresh player delta', patch: { kind: 'boot-probe', route: true, song: false, fresh: false, established: false }, expected: 'apply' },
];
for (const { name, patch, expected } of applicabilityCases) {
  test(`old applicability: ${name}`, () => {
    const f = fixture(); Object.assign(f.state, patch);
    assert.equal(f.workflow.applicability(f.state.kind), expected);
    assert.deepEqual(mutations(f.events), []);
  });
}

const desiredCases: { name: string; patch: Partial<State>; expected: number | null }[] = [
  { name: 'legacy content reference lag', patch: {}, expected: 250 },
  { name: 'Robot content carried into live coordinates', patch: { route: true }, expected: 275 },
  { name: 'quiet content mapping offers no new desired lag', patch: { route: true, mapping: false }, expected: null },
  { name: 'stale content', patch: { stale: true }, expected: null },
  { name: 'missing content result', patch: { result: null }, expected: null },
  { name: 'missing content live mapping result', patch: { route: true, mappingOffset: null }, expected: null },
  { name: 'Robot boot media delta at rate two', patch: { route: true, kind: 'boot-probe' }, expected: 200 },
  { name: 'Robot boot no Song uses path alone', patch: { route: true, kind: 'boot-probe', song: false, sourceConnected: false }, expected: 150 },
  { name: 'Robot boot no path', patch: { route: true, kind: 'boot-probe', path: null }, expected: null },
  { name: 'Robot boot completed context mismatch', patch: { route: true, kind: 'boot-probe', completed: false }, expected: null },
  { name: 'Robot boot missing result', patch: { route: true, kind: 'boot-probe', result: null }, expected: null },
  { name: 'Robot boot stale capture', patch: { route: true, kind: 'boot-probe', stale: true }, expected: null },
  { name: 'Robot boot missing Source while Song plays', patch: { route: true, kind: 'boot-probe', sourceConnected: false }, expected: null },
  { name: 'Robot boot held delta', patch: { route: true, kind: 'boot-probe', fresh: false }, expected: null },
  { name: 'boot provenance on legacy route is not Robot arithmetic', patch: { kind: 'boot-probe' }, expected: 250 },
];
for (const { name, patch, expected } of desiredCases) {
  test(`old desired lag: ${name}`, () => {
    const f = fixture(); Object.assign(f.state, patch);
    assert.equal(f.workflow.desiredLag(9), expected);
    assert.deepEqual(mutations(f.events), []);
  });
}

test('desired Robot boot keeps caller time separate from nested applicability sampling', () => {
  const f = fixture(); Object.assign(f.state, { route: true, kind: 'boot-probe' });
  assert.equal(f.workflow.desiredLag(9), 200);
  assert.deepEqual(f.events, [...appliedTrace, 'robot.route', 'cal.result', ...contextTrace,
    'cal.stale', 'probe.context', 'probe.completed', 'room.song:9', ...applicabilityTrace(101),
    'probe.path', 'delta:9', 'rate:9']);
});

test('desired Robot boot stale identity returns before completed-context, Song or clock reads', () => {
  const f = fixture(); Object.assign(f.state, { route: true, kind: 'boot-probe', stale: true });
  assert.equal(f.workflow.desiredLag(9), null);
  assert.deepEqual(f.events, [...appliedTrace, 'robot.route', 'cal.result', ...contextTrace, 'cal.stale']);
});

type SyncCase = { name: string; patch: Partial<State>; changed: boolean; active: number | null; effects: string[] };
const contentSyncCases: SyncCase[] = [
  { name: 'legacy installs confirmed lag', patch: {}, changed: true, active: 250, effects: ['timing.clear-slew', 'mix.set:250'] },
  { name: 'identical legacy alignment', patch: { active: 250 }, changed: false, active: 250, effects: [] },
  { name: 'Robot offset jitter stays held', patch: { route: true, active: 270 }, changed: false, active: 270, effects: [] },
  { name: 'Robot offset threshold equality installs', patch: { route: true, active: 255 }, changed: true, active: 275, effects: ['timing.clear-slew', 'mix.set:275'] },
  { name: 'matching validation revision slews', patch: { route: true, active: 250, slewRevision: 7 }, changed: true, active: 250, effects: ['timing.clear-slew', 'mix.slew:275'] },
  { name: 'slew returns the actual owner false result', patch: { route: true, active: 250, slewRevision: 7, slewReturn: false }, changed: false, active: 250, effects: ['timing.clear-slew', 'mix.slew:275'] },
  { name: 'mismatched prepared slew bypasses jitter and sets', patch: { route: true, active: 270, slewRevision: 8 }, changed: true, active: 275, effects: ['timing.clear-slew', 'mix.set:275'] },
  { name: 'matching revision on equal lag clears only metadata', patch: { route: true, active: 275, slewRevision: 7 }, changed: false, active: 275, effects: ['timing.clear-slew'] },
  { name: 'mismatched revision on equal lag is not consumed', patch: { route: true, active: 275, slewRevision: 8 }, changed: false, active: 275, effects: [] },
  { name: 'in-progress target is not reissued or snapped', patch: { route: true, active: 200, target: 275 }, changed: false, active: 200, effects: [] },
  { name: 'stale result revokes alignment', patch: { active: 250, stale: true }, changed: true, active: null, effects: ['timing.clear-slew', 'mix.set:null'] },
  { name: 'already revoked matching revision clears metadata', patch: { stale: true, slewRevision: 7 }, changed: false, active: null, effects: ['timing.clear-slew'] },
  { name: 'quiet mapping preserves alignment and prepared revision', patch: { route: true, mapping: false, active: 250, slewRevision: 7 }, changed: false, active: 250, effects: [] },
  { name: 'no confirmed result revokes old alignment', patch: { kind: 'none', result: null, active: 250 }, changed: true, active: null, effects: ['timing.clear-slew', 'mix.set:null'] },
  { name: 'missing live-lag result cannot install reference coordinates', patch: { route: true, mappingOffset: null, active: 250 }, changed: true, active: null, effects: ['timing.clear-slew', 'mix.set:null'] },
  { name: 'non-content authority cannot take validation slew', patch: { kind: 'boot-probe', active: 100, slewRevision: 7 }, changed: true, active: 250, effects: ['timing.clear-slew', 'mix.set:250'] },
];
for (const { name, patch, changed, active, effects } of contentSyncCases) {
  test(`old non-Boot mixer sync: ${name}`, () => {
    const f = fixture(); Object.assign(f.state, patch);
    assert.equal(f.workflow.syncApplied(), changed);
    assert.equal(f.state.active, active);
    assert.deepEqual(mutations(f.events), effects);
    if (!effects.includes('timing.clear-slew')) assert.equal(f.state.slewRevision, patch.slewRevision ?? null);
  });
}

const bootSyncCases: SyncCase[] = [
  { name: 'matching stored delta restores total', patch: {}, changed: true, active: 250, effects: ['mix.set:250'] },
  { name: 'already applied total', patch: { active: 250 }, changed: false, active: 250, effects: [] },
  { name: 'different live total is replaced by confirmed total', patch: { active: 200 }, changed: true, active: 250, effects: ['mix.set:250'] },
  { name: 'delta movement leaves current total serving', patch: { active: 250, delta: 100.002 }, changed: false, active: 250, effects: [] },
  { name: 'delta movement does not resurrect inactive historical total', patch: { delta: 100.002 }, changed: false, active: null, effects: [] },
  { name: 'sub-epsilon stored delta is accepted', patch: { delta: 100.0005 }, changed: true, active: 250, effects: ['mix.set:250'] },
  { name: 'provenance-less total is revoked', patch: { storedDelta: null, active: 250 }, changed: true, active: null, effects: ['mix.set:null'] },
  { name: 'provenance-less inactive total stays inactive', patch: { storedDelta: null }, changed: false, active: null, effects: [] },
  { name: 'stale capture revokes serving total', patch: { stale: true, active: 250 }, changed: true, active: null, effects: ['mix.set:null'] },
  { name: 'no Song installs path even when Source is quiet', patch: { song: false, sourceConnected: false, active: 250 }, changed: true, active: 150, effects: ['mix.set:150'] },
  { name: 'no Song already has path', patch: { song: false, active: 150 }, changed: false, active: 150, effects: [] },
  { name: 'playing Song without Source revokes', patch: { sourceConnected: false, active: 250 }, changed: true, active: null, effects: ['mix.set:null'] },
  { name: 'temporarily quiet delta holds total', patch: { fresh: false, active: 250 }, changed: false, active: 250, effects: [] },
  { name: 'never established delta revokes total', patch: { fresh: false, established: false, active: 250 }, changed: true, active: null, effects: ['mix.set:null'] },
  { name: 'missing confirmed result cannot serve old total', patch: { result: null, active: 250 }, changed: true, active: null, effects: ['mix.set:null'] },
];
for (const { name, patch, changed, active, effects } of bootSyncCases) {
  test(`old Robot Boot mixer sync: ${name}`, () => {
    const f = fixture(); Object.assign(f.state, { kind: 'boot-probe', route: true }, patch);
    assert.equal(f.workflow.syncApplied(), changed);
    assert.equal(f.state.active, active);
    assert.deepEqual(mutations(f.events), effects);
  });
}

test('non-Boot mixer sync samples live coordinates after applicability and clears metadata before installing', () => {
  const f = fixture(); f.state.route = true;
  assert.equal(f.workflow.syncApplied(), true);
  assert.deepEqual(f.events, ['take.blocked', 'mix.alignment', ...appliedTrace, 'robot.route',
    ...applicabilityTrace(101), 'cal.result', 'robot.route', 'clock:102', ...contextTrace,
    'timeline.live:250:102', 'timing.slew-revision', 'cal.revision', 'timing.slew-matches:7',
    'mix.target', 'timing.clear-slew', 'mix.set:275']);
});

test('Boot mixer sync preserves outer and nested clocks instead of caching all facts at one tick', () => {
  const f = fixture(); Object.assign(f.state, { route: true, kind: 'boot-probe' });
  assert.equal(f.workflow.syncApplied(), true);
  assert.deepEqual(f.events, ['take.blocked', 'mix.alignment', ...appliedTrace, 'robot.route',
    'clock:101', 'cal.result', 'room.song:101', 'probe.path', ...contextTrace, 'cal.stale',
    'probe.context', 'probe.completed', ...applicabilityTrace(102), 'probe.result',
    'delta:101', 'mix.set:250']);
});

for (const phase of ['recording', 'finalizing'] as const) {
  test(`old mixer sync ${phase} Take returns before alignment or authority reads`, () => {
    const f = fixture(); f.state.takePhase = phase; f.state.throwAt = 'mix.alignment';
    assert.equal(f.workflow.syncApplied(), false);
    assert.deepEqual(f.events, ['take.blocked']);
    assert.equal(f.state.active, null);
  });
}

test('a throwing clock stops applicability before any authority facts are sampled', () => {
  const f = fixture(); f.state.throwAt = 'clock:101';
  assert.throws(() => f.workflow.applicability('content'), /port threw at clock:101/);
  assert.deepEqual(f.events, ['clock:101']);
});

test('a throwing slew metadata clear prevents the later alignment effect', () => {
  const f = fixture(); f.state.throwAt = 'timing.clear-slew';
  assert.throws(() => f.workflow.syncApplied(), /port threw at timing.clear-slew/);
  assert.deepEqual(mutations(f.events), ['timing.clear-slew']);
  assert.equal(f.state.active, null);
});

test('a throwing slew command propagates after metadata is consumed, without snapping alignment', () => {
  const f = fixture(); Object.assign(f.state, { route: true, active: 250, slewRevision: 7, throwAt: 'mix.slew:275' });
  assert.throws(() => f.workflow.syncApplied(), /port threw at mix.slew:275/);
  assert.deepEqual(mutations(f.events), ['timing.clear-slew', 'mix.slew:275']);
  assert.equal(f.state.slewRevision, null);
  assert.equal(f.state.active, 250);
});

function answer(lag: number): TimingCalibrationAnalysis {
  return { micLagMs: lag, confidence: 0.9, segmentLagsMs: [lag],
    segmentCorrelations: [0.9], micLevelDbfs: -20, backingLevelDbfs: -12 };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

// The real generation, confirmation, provenance, retained probe, mapping and
// mixer owners execute the original application bodies. Only completion and
// external transport/config facts are controlled; this is not an acoustic proof.
function measuredFixture(agreementWindows = 1) {
  const f = fixture();
  const control = { now: 0, deferred: true, lag: 315, micRate: 48_000, backingRate: 44_100,
    takePhase: 'idle' as 'idle' | 'recording' | 'finalizing' };
  const mix = new AudioSession({ sampleRate: 48_000, frameMs: 20, prebufferMs: 0,
    backingGain: 1, retentionMs: 5_000 });
  mix.start(0);
  mix.ingestMic({ generation: 2, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, control.micRate, 0);
  mix.ingestBacking({ generation: 3, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, control.backingRate, 0);
  const source = new SourceRuntime<{ isRobotSource?: boolean }>({ isConnected: () => true });
  source.attachRobot({});
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 100 });
  const probe = new BootProbeRuntime({ maxAttempts: 1, retryMs: 100 });
  const mapper = new RobotContentTimelineMapper({ sampleRate: 48_000, freshForMs: 10_000 });
  const pending: Array<{ signal: AbortSignal | undefined; resolve(value: TimingCalibrationAnalysis): void;
    reject(error: unknown): void }> = [];
  const settled: Array<{ revision: number; authorityRevision: number; kind: CalibrationAuthorityKind;
    appliedLag: number | null }> = [];
  // As in production, constructors only save these callbacks. No mutable let!
  // or setter fills in an unfinished assembly, and no callback runs eagerly.
  function context(): CalibrationContext { return workflow.context(); }
  function bootContext(): BootProbeContext {
    const value = context();
    return { sessionGeneration: value.sessionGeneration, micGeneration: value.micGeneration,
      backingGeneration: value.backingGeneration, micSourceRate: value.micSourceRate,
      backingSourceRate: value.backingSourceRate };
  }
  const calibration = new CalibrationSession({ sampleRate: 48_000, durationMs: 20,
    timeoutMs: 5_000, agreementWindows, provisionalConfidence: 0.55,
    now: () => control.now, context,
    analyze: (_mic, _backing, _rate, _maxLag, signal) => {
      if (!control.deferred) return answer(control.lag);
      return new Promise<TimingCalibrationAnalysis>((resolve, reject) => pending.push({ signal, resolve, reject }));
    },
    onSettled: () => {
      f.events.push('settled:authority');
      timing.syncConfirmedAuthority({ confirmedRevision: calibration.confirmedRevision,
        hasConfirmedResult: calibration.confirmedResult !== null });
      f.events.push('settled:mixer');
      workflow.syncApplied();
      f.events.push('settled:timing', 'settled:source');
      settled.push({ revision: calibration.confirmedRevision, authorityRevision: timing.authorityRevision,
        kind: timing.authorityKind, appliedLag: mix.alignment.calibratedMicLagMs });
    },
  });
  const dependencies = { ...f.dependencies, session: mix, calibration, timingRuntime: timing,
    bootProbeRuntime: probe, sourceRuntime: source, robotContentTimeline: mapper,
    micRuntime: { get sampleRate() { return control.micRate; } },
    backingRuntime: { get sampleRate() { return control.backingRate; } },
    performance: { now: () => control.now },
    takeBlocksCalibration: () => control.takePhase !== 'idle',
    robotRouteActive: () => true, robotProbeTimingActive: () => true,
    bootProbeContext: bootContext,
    bootProbeSettled: () => probe.status(control.now).error !== null
      || (probe.pathDifferenceMs !== null && probe.completedContextMatches(bootContext())),
    roomHasSong: () => true, robotDeltaIsFresh: () => true,
    robotDeltaEverEstablished: () => true,
    robotContentMappingReady: (nowMs: number) => mapper.isReady(context(), nowMs),
    currentDeltaMs: () => 100, currentPlaybackRate: () => 2,
  };
  const workflow = workflowFromPorts(dependencies);
  const failure = createRelayBootProbeFailureSettlementCoordinator({
    restoreCandidateKindToAuthority() { f.events.push('failure:restore'); timing.restoreCandidateKindToAuthority(); },
    failPreservingPrimed(message) { f.events.push('failure:settle'); calibration.failPreservingPrimed(message); },
    reportTimingStatus() { f.events.push('failure:retry'); },
  });
  function refreshMapping() { assert.equal(mapper.notePlayerOffset(100, context(), control.now, 2), true); }
  function seedContent(lag = 240) {
    timing.markContentAuthority(); calibration.applyValidatedResult(answer(lag));
  }
  function seedBoot() {
    timing.markBootProbeAuthority(); calibration.applyExternalResult({ micLagMs: 200, confidence: 0.9 });
  }
  function exhaustCurrentBoot() {
    calibration.beginExternalRecalibration(); timing.beginBootProbe(false); probe.abandonRun();
    const requestId = probe.nextRequestId();
    assert.equal(probe.beginRequest({ target: 'mic', requestId, serverSentAtMs: control.now,
      sessionGeneration: mix.generation, generation: mix.micGeneration! }), true);
    assert.equal(failure.settle(probe.failAttempt('mic', 'new context bounded boot exhausted', control.now)), 'terminal');
    assert.notEqual(probe.status(control.now).error, null);
  }
  function beginContent() {
    timing.beginContentCalibration(control.now, false); calibration.start(control.now);
  }
  function feedWindow(index = 0) {
    const pcm = new Int16Array(960);
    calibration.observeMic(pcm, index * pcm.length);
    calibration.observeBacking(pcm, index * pcm.length);
  }
  refreshMapping();
  probe.recordCalibration(bootContext(), { advanceMs: 200, micLatencyMs: 200,
    backingLatencyMs: 50, deltaMs: 100, confidence: 0.9 });
  return { f, control, mix, source, timing, probe, mapper, calibration, pending, settled,
    workflow, context, bootContext, failure, refreshMapping, seedContent, seedBoot, exhaustCurrentBoot, beginContent, feedWindow };
}

const settlementTrace = ['settled:authority', 'settled:mixer', 'settled:timing', 'settled:source'];
for (const previousKind of ['content', 'boot-probe'] as const) {
  for (const readStatus of [false, true]) {
    test(`real failed boot replacement retains ${previousKind} authority, status read=${readStatus}`, () => {
      const h = measuredFixture();
      if (previousKind === 'content') h.seedContent(); else h.seedBoot();
      const lag = previousKind === 'content' ? 240 : 200;
      const confirmed = h.calibration.confirmedResult;
      const boot = h.probe.calibrationResult;
      assert.equal(h.calibration.confirmedRevision, 1);
      assert.equal(h.timing.authorityRevision, 1);
      assert.equal(h.timing.authorityKind, previousKind, 'settlement synchronizes before any observer reads');
      assert.equal(h.mix.alignment.calibratedMicLagMs, lag);
      h.calibration.beginExternalRecalibration(); h.timing.beginBootProbe(false); h.probe.abandonRun();
      assert.equal(h.calibration.transactionActive, true);
      assert.equal(h.workflow.applicability(previousKind), 'apply');
      assert.equal(h.workflow.syncApplied(), false);
      if (readStatus) { h.calibration.status(); h.workflow.appliedKind(); h.workflow.desiredLag(0); }
      assert.equal(h.timing.authorityRevision, 1);
      assert.equal(h.timing.authorityKind, previousKind);
      const requestId = h.probe.nextRequestId();
      assert.equal(h.probe.beginRequest({ target: 'mic', requestId, serverSentAtMs: 0,
        sessionGeneration: h.mix.generation, generation: h.mix.micGeneration! }), true);
      h.f.events.length = 0;
      assert.equal(h.failure.settle(h.probe.failAttempt('mic', 'bounded replacement failure', 0)), 'terminal');
      assert.deepEqual(h.f.events, ['failure:restore', 'failure:settle', ...settlementTrace]);
      assert.equal(h.calibration.transactionActive, false);
      assert.equal(h.calibration.status().state, 'failed');
      assert.deepEqual(h.calibration.confirmedResult, confirmed);
      assert.deepEqual(h.probe.calibrationResult, boot);
      assert.equal(h.calibration.confirmedRevision, 1);
      assert.equal(h.timing.authorityRevision, 1);
      assert.equal(h.timing.authorityKind, previousKind);
      assert.equal(h.timing.calibrationKind, previousKind);
      assert.equal(h.workflow.appliedKind(), previousKind);
      assert.equal(h.mix.alignment.calibratedMicLagMs, lag);
      assert.deepEqual(h.settled.at(-1), { revision: 1, authorityRevision: 1, kind: previousKind, appliedLag: lag });
    });
  }
}

for (const readStatus of [false, true]) {
  test(`real background content retains boot provenance without relying on status reads: ${readStatus}`, () => {
    const h = measuredFixture(); h.seedBoot();
    h.f.events.length = 0; h.beginContent();
    assert.equal(h.calibration.collecting, true);
    assert.equal(h.timing.calibrationKind, 'content');
    if (readStatus) { h.calibration.status(); h.workflow.appliedKind(); h.workflow.desiredLag(0); }
    assert.equal(h.timing.authorityKind, 'boot-probe');
    assert.equal(h.timing.authorityRevision, 1);
    assert.equal(h.workflow.appliedKind(), 'boot-probe');
    assert.equal(h.workflow.desiredLag(0), 200);
    assert.equal(h.workflow.syncApplied(), false);
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 200);
    assert.deepEqual(h.f.events, [], 'queries and beginning a retained retry add no settlement/publication');
  });
}

test('real provisional content applies its candidate and revokes it on failure without inventing confirmed provenance', () => {
  const h = measuredFixture(2); h.control.deferred = false;
  h.beginContent(); h.feedWindow();
  assert.equal(h.calibration.status().provisional, true);
  assert.equal(h.calibration.confirmedResult, null);
  assert.equal(h.calibration.confirmedRevision, 0);
  assert.equal(h.timing.authorityKind, 'none');
  assert.equal(h.workflow.appliedKind(), 'content');
  assert.equal(h.mix.alignment.calibratedMicLagMs, 315);
  h.calibration.fail('later agreement failed');
  assert.equal(h.calibration.result, null);
  assert.equal(h.calibration.confirmedRevision, 0);
  assert.equal(h.timing.authorityRevision, 0);
  assert.equal(h.workflow.appliedKind(), 'none');
  assert.equal(h.mix.alignment.calibratedMicLagMs, null);
  assert.deepEqual(h.f.events, [...settlementTrace, ...settlementTrace]);
});

test('real validated promotion consumes the prepared revision before handing a target to AudioSession slew', () => {
  const h = measuredFixture(); h.seedContent(); h.f.events.length = 0;
  h.timing.markContentAuthority();
  h.timing.prepareContentValidationSlew(h.calibration.confirmedRevision + 1);
  h.calibration.applyValidatedResult(answer(300));
  assert.equal(h.calibration.confirmedRevision, 2);
  assert.equal(h.timing.authorityRevision, 2);
  assert.equal(h.timing.contentValidationSlewRevision, null);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 240, 'promotion must not snap the audible read head');
  assert.equal(h.mix.calibratedMicLagTarget, 300);
  assert.equal(h.workflow.desiredLag(0), 300);
  assert.equal(h.workflow.syncApplied(), false, 'the already handed-off target must not be reissued');
  assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
  assert.deepEqual(h.f.events, settlementTrace);
});

for (const phase of ['recording', 'finalizing'] as const) {
  test(`real mixer stays frozen during ${phase} while desired alignment keeps following mapping`, () => {
    const h = measuredFixture(); h.seedContent(); h.control.takePhase = phase;
    assert.equal(h.mapper.notePlayerOffset(180, h.context(), 0, 2), true);
    assert.equal(h.workflow.desiredLag(0), 280);
    h.timing.prepareContentValidationSlew(2);
    assert.equal(h.workflow.syncApplied(), false);
    assert.equal(h.mix.alignment.calibratedMicLagMs, 240);
    assert.equal(h.timing.contentValidationSlewRevision, 2);
    assert.equal(h.calibration.confirmedRevision, 1);
    assert.equal(h.timing.authorityRevision, 1);
  });
}

type MeasuredFixture = ReturnType<typeof measuredFixture>;
const identityChanges: { name: string; change(h: MeasuredFixture): void }[] = [
  { name: 'session generation', change(h) {
    h.mix.stop(); h.mix.start(h.control.now);
    h.mix.ingestMic({ generation: 2, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, h.control.micRate, 0);
    h.mix.ingestBacking({ generation: 3, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, h.control.backingRate, 0);
  } },
  { name: 'Mic generation', change(h) { h.mix.ingestMic({ generation: 11, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, h.control.micRate, 0); } },
  { name: 'Backing generation', change(h) { h.mix.ingestBacking({ generation: 12, firstSampleIndex: 0, pcm: Buffer.alloc(4) }, h.control.backingRate, 0); } },
  { name: 'Source generation', change(h) { h.source.invalidateMapping(); } },
  { name: 'Mic rate only', change(h) { h.control.micRate = 44_100; } },
  { name: 'Backing rate only', change(h) { h.control.backingRate = 48_000; } },
];
for (const identity of identityChanges) {
  for (const completion of ['resolve', 'reject'] as const) for (const successor of [false, true]) {
    test(`real old worker ${completion} after ${identity.name}, confirmed successor=${successor}`, async () => {
      const h = measuredFixture(); h.seedContent();
      const retained = h.calibration.confirmedResult;
      const originalContext = h.context();
      h.beginContent(); h.feedWindow();
      assert.equal(h.pending.length, 1);
      assert.equal(h.pending[0].signal?.aborted, false);
      assert.equal(h.calibration.confirmedRevision, 1);
      identity.change(h);
      assert.notDeepEqual(h.context(), originalContext, 'the named identity change must reach the real context');
      if (successor) {
        // A new capture/rate retires the boot baseline too. Content can serve
        // only after the new bounded probe settles; never fake that gate open.
        if (!h.probe.completedContextMatches(h.bootContext())) h.exhaustCurrentBoot();
        h.refreshMapping(); h.seedContent(350);
        assert.equal(h.pending[0].signal?.aborted, true);
        assert.equal(h.calibration.confirmedRevision, 2);
        assert.equal(h.mix.alignment.calibratedMicLagMs, 350);
      }
      const publications = [...h.f.events];
      if (completion === 'resolve') h.pending[0].resolve(answer(900));
      else h.pending[0].reject(new Error('retired analysis failed'));
      await nextTurn();
      assert.equal(h.calibration.confirmedRevision, successor ? 2 : 1);
      assert.equal(h.timing.authorityRevision, successor ? 2 : 1);
      assert.equal(h.timing.authorityKind, 'content');
      assert.equal(h.workflow.appliedKind(), 'content');
      assert.equal(h.mix.alignment.calibratedMicLagMs, successor ? 350 : null);
      if (successor) {
        assert.equal(h.calibration.status().state, 'complete');
        assert.equal(h.calibration.confirmedResult?.micLagMs, 350);
        assert.deepEqual(h.f.events, publications, 'retired completion cannot fail or republish the valid successor');
      } else {
        assert.equal(h.calibration.status().state, 'failed');
        assert.deepEqual(h.calibration.confirmedResult, retained, 'context rejection retains confirmation history');
        assert.equal(h.workflow.desiredLag(0), null);
        assert.deepEqual(h.f.events, [...publications, ...settlementTrace]);
      }
    });
  }
}
