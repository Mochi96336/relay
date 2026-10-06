import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CalibrationContext } from '../src/calibration-session.js';
import { createRelayRobotMappingOrchestration, createRelayRobotSourceLifecycle,
  type RelayRobotSourceLifecycleDependencies, type RelayRobotSourceMappingMethods } from '../src/relay-robot-mapping-orchestration.js';
import type { RelaySourceSeekTransactionInput } from '../src/relay-source-seek-transaction-coordinator.js';
import { SourceRuntime, type SourceRuntimeSocket } from '../src/source-runtime.js';
import { functionCode, objectArrowCallbackCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
type Socket = SourceRuntimeSocket & { readyState: number; replaced?: boolean };
type Seek = RelaySourceSeekTransactionInput<CalibrationContext>;
type Workflow = {
  activateSource(input: { previous: Socket | null; replaced: boolean }): void;
  disconnectSource(socket: Socket): boolean;
  dropLegacyCalibration(): void;
  handleSourceSeek(input: Seek): 'mapped-follower-correction' | 'destructive-seek';
};
const context: CalibrationContext = { sessionGeneration: 3, micGeneration: 4,
  backingGeneration: 5, sourceGeneration: 6 };
const changed = 'fail:The Robot source changed during calibration. Start calibration again.';
const seekFailed = 'fail:The desktop player seeked during calibration. Start calibration again.';
const dropEffects = ['baseline', 'calibration.reset', 'kind.clear', 'schedule.reset', 'sync'];
const resetAndReport = ['offset.reset', 'timeline.reset', 'transition.clear', 'route', 'sync', 'source', 'timing'];
const replacement = ['notify', 'quality:robot-source-replaced', 'abandon', 'collecting', changed,
  ...resetAndReport];
const disconnect = ['isActive', 'quality:robot-source-disconnected', 'detach', 'offset.reset',
  'timeline.reset', 'transition.clear', 'abandon', 'collecting', changed, 'sync', 'source', 'timing'];
const mapped = ['offset.reset', 'applied-kind', 'playback-rate:0', 'begin:0', 'sync', 'source', 'timing'];
const destructive = ['offset.reset', 'offset.reset', 'timeline.reset', 'transition.clear',
  'invalidate', 'discard', 'baseline', 'collecting', seekFailed, 'sync', 'source', 'timing'];

// C2 executes the actual canonical server root and actual protocol callbacks.
// All C0 fixed case bodies and traces remain unchanged; temporary legacy adapters are gone.
function createWorkflow(inputs: object,
  factory: typeof createRelayRobotMappingOrchestration = createRelayRobotMappingOrchestration): Workflow {
  const ports = { ...inputs, createRelayRobotMappingOrchestration: factory };
  return new Function(...Object.keys(ports), `
    const root = ${variableInitializerCode(server, 'relayRobotMapping')};
    return { activateSource: root.activateSource, disconnectSource: root.disconnectSource,
      dropLegacyCalibration: root.dropLegacyCalibration, handleSourceSeek: root.handleSourceSeek };
  `)(...Object.values(ports)) as Workflow;
}

function fixture(options: { route?: boolean; kind?: 'none' | 'content' | 'boot-probe'; settled?: boolean;
  collecting?: boolean; active?: boolean; current?: boolean; throwAt?: string;
  collectingAfterAbandon?: boolean; now?: number; authorized?: boolean; seekAllowed?: boolean;
  activeRobot?: boolean; backingRobot?: boolean; preserve?: boolean; correction?: boolean;
  actualSource?: SourceRuntime<Socket> } = {}) {
  const events: string[] = [], error = new Error('original synchronous Robot source failure');
  const socket: Socket = { readyState: 1 }, previous: Socket = options.actualSource?.socket ?? { readyState: 1 };
  const state = { collecting: options.collecting === true, kind: options.kind ?? 'none',
    pre: 0 as number | null, reference: 0 as number | null, received: null as Seek | null };
  const note = (event: string) => { events.push(event); if (event === options.throwAt) throw error; };
  const unexpected = () => { throw new Error('unrelated mapping port was touched'); };
  const inputs = {
    WebSocket: { OPEN: 1 }, MIX_SAMPLE_RATE: 48_000,
    ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES: 144_000, MAX_CAPTURE_GAP_MS: 300,
    backingRuntime: { get isRobot() { note('route'); return options.route === true; } },
    sourceRuntime: options.actualSource ?? {
      connected: () => false,
      isActive: (candidate: Socket) => { assert.equal(candidate, socket); note('isActive'); return options.current !== false; },
      detachRobot: (candidate: Socket) => { assert.equal(candidate, socket); note('detach'); return true; },
      invalidateMapping: () => note('invalidate'),
    },
    robotPlayerOffset: { reset: () => note('offset.reset') },
    robotContentTimeline: { reset: () => note('timeline.reset'),
      get currentDeltaMs() { note('pre'); return state.pre; },
      get referenceDeltaMs() { note('reference'); return state.reference; } },
    calibration: {
      get collecting() { note('collecting'); return state.collecting; },
      fail: (reason: string) => note(`fail:${reason}`), reset: () => note('calibration.reset'),
      discardPrimedContent: () => note('discard'),
    },
    contentCalibrationValidator: new Proxy({}, { get: unexpected }),
    timingRuntime: {
      get calibrationKind() { note('kind'); return state.kind; },
      clearCalibrationKind: () => note('kind.clear'),
      resetAutoCalibrationSchedule: () => note('schedule.reset'),
    },
    robotContentTransitionRuntime: {
      clear: () => note('transition.clear'),
      begin: (input: { fromMediaTime: number; toMediaTime: number; preDeltaMs: number;
        referenceDeltaMs: number; context: CalibrationContext; confirmedReferenceLagMs: number | null;
        playbackRate: number }, now: number) => {
        assert.equal(input.context, context); assert.equal(input.fromMediaTime, 10.5);
        assert.equal(input.toMediaTime, 9); assert.equal(input.preDeltaMs, 0);
        assert.equal(input.referenceDeltaMs, 0); assert.equal(input.confirmedReferenceLagMs, null);
        assert.equal(input.playbackRate, 1); note(`begin:${now}`);
      },
    },
    session: { get active() { note('session.active'); return options.active !== false; } },
    takeController: { noteQualityEvent: (event: string) => note(`quality:${event}`) },
    calibrationContext: () => { note('context'); return context; },
    appliedCalibrationKind: () => { note('applied-kind'); return 'none'; },
    calibrationIsStale: unexpected,
    currentPlaybackRate: (now: number) => { note(`playback-rate:${now}`); return 1; },
    feedContentBackingEvidence: unexpected,
    clearContentValidationBaseline: () => note('baseline'),
    syncAppliedCalibration: () => note('sync'),
    broadcastJson: (payload: { type: string }) => note(payload.type),
    sourceStatusPayload: () => ({ type: 'source' }), timingCalibrationStatusPayload: () => ({ type: 'timing' }),
    sendJson: (target: Socket, message: { type: string }) => {
      assert.equal(target, previous); assert.equal(message.type, 'robot-source-replaced'); note('notify');
    },
    bootProbeSettled: () => { note('settled'); return options.settled === true; },
    abandonProbeRun: () => {
      note('abandon');
      if (options.collectingAfterAbandon !== undefined) state.collecting = options.collectingAfterAbandon;
    },
  };
  const workflow = createWorkflow(inputs);
  const handler = (variable: string, property: string, ports: object) => {
    const callback = objectArrowCallbackCode(server, variable, property).slice(property.length + 1);
    return new Function(...Object.keys(ports), `return (${callback});`)(...Object.values(ports)) as
      (socket: Socket, payload: object) => void;
  };
  const hello = handler('robotLifecycleProtocol', 'robotSourceHello', {
    infrastructureCapability: { authorized: () => { note('authorized'); return options.authorized !== false; } },
    rejectInfrastructure: (_target: Socket, message: string) => note(`reject:${message}`),
    sourceRuntime: options.actualSource ?? {
      isActive: () => { note('hello.isActive'); return options.current === true; },
      attachRobot: (target: Socket) => { assert.equal(target, socket); note('attach'); return { previous: null, replaced: false }; },
    },
    relayRobotMapping: { activateSource: workflow.activateSource },
  });
  const seek = handler('infrastructureEventProtocol', 'sourceSeeked', {
    infrastructureCapability: { authorized: () => { note('authorized'); return options.authorized !== false; } },
    rejectInfrastructure: (_target: Socket, message: string) => note(`reject:${message}`),
    sourceRuntime: options.actualSource ?? {
      canReportSeek: () => { note('canSeek'); return options.seekAllowed !== false; },
      isActiveRobot: () => { note('activeRobot'); return options.activeRobot !== false; },
    },
    performance: { now: () => { note('clock'); return options.now ?? 0; } },
    robotContentTransitionRuntime: { clearPendingBoundary: () => note('pending.clear') },
    calibrationContext: inputs.calibrationContext,
    robotContentTimeline: { get currentDeltaMs() { return inputs.robotContentTimeline.currentDeltaMs; },
      get referenceDeltaMs() { return inputs.robotContentTimeline.referenceDeltaMs; },
      noteFollowerCorrection: (from: number, to: number, actual: CalibrationContext, now: number) => {
        assert.equal(from, 10.5); assert.equal(to, 9); assert.equal(actual, context);
        assert.equal(now, options.now ?? 0); note('correction'); return options.correction !== false;
      } },
    backingRuntime: { get isRobot() { note('backingRobot'); return options.backingRobot !== false; } },
    robotFollowerSeekMayPreserveMapping: (now: number) => {
      assert.equal(now, options.now ?? 0); note('preserve'); return options.preserve !== false;
    },
    relayRobotMapping: { handleSourceSeek: (input: Seek) => {
      assert.equal(input.context, context); state.received = input; return workflow.handleSourceSeek(input);
    } },
  });
  return { workflow, inputs, events, error, state, socket, previous, hello, seek };
}

function seekInput(overrides: Partial<Seek> = {}): Seek {
  return { mappedFollowerCorrection: true, fromMediaTime: 10.5, toMediaTime: 9,
    preDeltaMs: 0, referenceDeltaMs: 0, context, nowMs: 0, ...overrides };
}

test('actual four source compositions plus protocol callback construction are inert', () => {
  const h = fixture(); assert.deepEqual(h.events, []);
  assert.deepEqual(Object.keys(h.workflow), ['activateSource', 'disconnectSource', 'dropLegacyCalibration', 'handleSourceSeek']);
});

for (const route of [false, true]) for (const kind of ['none', 'boot-probe', 'content'] as const)
  for (const settled of [false, true]) test(`legacy drop retains route/kind/settled short circuits: ${route}/${kind}/${settled}`, () => {
    const h = fixture({ route, kind, settled }); assert.equal(h.workflow.dropLegacyCalibration(), undefined);
    assert.deepEqual(h.events, ['route', ...(route ? ['kind', ...(kind === 'content'
      ? ['settled', ...(!settled ? dropEffects : [])] : [])] : [])]);
  });

for (const hasPrevious of [false, true]) for (const replaced of [false, true])
  for (const active of [false, true]) for (const collecting of [false, true]) {
    test(`activation preserves previous/replaced/session/collecting truth table: ${hasPrevious}/${replaced}/${active}/${collecting}`, () => {
      const h = fixture({ active, collecting });
      const input = { previous: hasPrevious ? h.previous : null, replaced };
      assert.equal(h.workflow.activateSource(input), undefined);
      assert.deepEqual(h.events, [...(hasPrevious && replaced
        ? ['notify', 'quality:robot-source-replaced', 'abandon', 'collecting', ...(collecting ? [changed] : [])]
        : !hasPrevious ? ['session.active', ...(active ? ['quality:robot-source-connected'] : [])] : []), ...resetAndReport]);
      assert.deepEqual(input, { previous: hasPrevious ? h.previous : null, replaced });
    });
  }

for (const collecting of [false, true]) test(`activation invokes the actual same legacy drop transaction before outer sync: ${collecting}`, () => {
  const h = fixture({ route: true, kind: 'content', collecting });
  h.workflow.activateSource({ previous: h.previous, replaced: true });
  assert.deepEqual(h.events, ['notify', 'quality:robot-source-replaced', 'abandon', 'collecting',
    ...(collecting ? [changed] : []), 'offset.reset', 'timeline.reset', 'transition.clear',
    'route', 'kind', 'settled', ...dropEffects, 'sync', 'source', 'timing']);
});

for (const current of [false, true]) for (const collecting of [false, true]) {
  test(`disconnect guards canonical socket and preserves boolean/order: ${current}/${collecting}`, () => {
    const h = fixture({ current, collecting });
    assert.equal(h.workflow.disconnectSource(h.socket), current);
    assert.deepEqual(h.events, current ? disconnect.filter(event => collecting || event !== changed) : ['isActive']);
  });
}

for (const entry of ['activation', 'disconnect'] as const) for (const collecting of [false, true]) {
  test(`collecting is sampled live after abandon, never constructor/admission: ${entry}/${collecting}`, () => {
    const h = fixture({ collecting: !collecting, collectingAfterAbandon: collecting });
    if (entry === 'activation') h.workflow.activateSource({ previous: h.previous, replaced: true });
    else h.workflow.disconnectSource(h.socket);
    assert.deepEqual(h.events, (entry === 'activation' ? replacement : disconnect)
      .filter(event => collecting || event !== changed));
    assert.equal(h.events.filter(event => event === 'collecting').length, 1);
  });
}

for (const nowMs of [0, 73.5]) for (const preDeltaMs of [null, 0]) for (const referenceDeltaMs of [null, 0]) {
  test(`mapped seek preserves zero/null deltas and passed clock/context identity: ${nowMs}/${preDeltaMs}/${referenceDeltaMs}`, () => {
    const h = fixture(), input = seekInput({ nowMs, preDeltaMs, referenceDeltaMs }), before = { ...input };
    assert.equal(h.workflow.handleSourceSeek(input), 'mapped-follower-correction');
    assert.deepEqual(h.events, ['offset.reset', ...(preDeltaMs !== null && referenceDeltaMs !== null
      ? ['applied-kind', `playback-rate:${nowMs}`, `begin:${nowMs}`] : []), 'sync', 'source', 'timing']);
    assert.deepEqual(input, before); assert.equal(input.context, context);
  });
}
for (const collecting of [false, true]) test(`destructive seek performs the entire existing revocation, including duplicate original offset reset: ${collecting}`, () => {
  const h = fixture({ collecting }), input = seekInput({ mappedFollowerCorrection: false,
    fromMediaTime: Number.NaN, toMediaTime: Number.NaN, preDeltaMs: null, referenceDeltaMs: null });
  assert.equal(h.workflow.handleSourceSeek(input), 'destructive-seek');
  assert.deepEqual(h.events, destructive.filter(event => collecting || event !== seekFailed));
});

const failurePaths = [
  { name: 'drop', trace: ['route', 'kind', 'settled', ...dropEffects],
    options: { route: true, kind: 'content' as const }, run: (h: ReturnType<typeof fixture>) => h.workflow.dropLegacyCalibration() },
  { name: 'activation', trace: replacement, options: { collecting: true },
    run: (h: ReturnType<typeof fixture>) => h.workflow.activateSource({ previous: h.previous, replaced: true }) },
  { name: 'disconnect', trace: disconnect, options: { collecting: true },
    run: (h: ReturnType<typeof fixture>) => h.workflow.disconnectSource(h.socket) },
  { name: 'mapped seek', trace: mapped, options: {},
    run: (h: ReturnType<typeof fixture>) => h.workflow.handleSourceSeek(seekInput()) },
  { name: 'destructive seek', trace: destructive, options: { collecting: true },
    run: (h: ReturnType<typeof fixture>) => h.workflow.handleSourceSeek(seekInput({ mappedFollowerCorrection: false })) },
];
for (const path of failurePaths) for (const throwAt of new Set(path.trace)) {
  test(`actual ${path.name} propagates identical synchronous exception and cuts off later effects: ${throwAt}`, () => {
    const h = fixture({ ...path.options, throwAt });
    assert.throws(() => path.run(h), value => value === h.error);
    assert.deepEqual(h.events, path.trace.slice(0, path.trace.indexOf(throwAt) + 1));
  });
}

test('actual hello unauthorized rejection cannot attach or invoke lifecycle', () => {
  const h = fixture({ authorized: false }); assert.equal(h.hello(h.socket, {}), undefined);
  assert.deepEqual(h.events, ['authorized', 'reject:Authenticate Relay infrastructure before becoming the Robot source.']);
});
test('actual hello current socket returns before attach and activation', () => {
  const h = fixture({ current: true }); h.hello(h.socket, {});
  assert.deepEqual(h.events, ['authorized', 'hello.isActive']);
});
test('actual hello completes attach before first connection effects', () => {
  const h = fixture(); h.hello(h.socket, {});
  assert.deepEqual(h.events, ['authorized', 'hello.isActive', 'attach', 'session.active',
    'quality:robot-source-connected', ...resetAndReport]);
});
test('actual seek unauthorized rejection cannot sample clock or mapping', () => {
  const h = fixture({ authorized: false }); h.seek(h.socket, {});
  assert.deepEqual(h.events, ['authorized', 'reject:Authenticate the active Source before reporting a seek.']);
});
test('actual seek without Source authority cannot sample clock or mapping', () => {
  const h = fixture({ seekAllowed: false }); h.seek(h.socket, {});
  assert.deepEqual(h.events, ['authorized', 'canSeek']);
});
const seekPrefix = ['authorized', 'canSeek', 'clock', 'pending.clear', 'context', 'pre', 'reference'];
for (const reason of ['follower-correction', 'user']) for (const activeRobot of [false, true])
  for (const backingRobot of [false, true]) for (const preserve of [false, true]) for (const correction of [false, true]) {
    test(`actual seek classification short circuits without gaining authority: ${reason}/${activeRobot}/${backingRobot}/${preserve}/${correction}`, () => {
      const h = fixture({ activeRobot, backingRobot, preserve, correction });
      h.seek(h.socket, { reason, fromMediaTime: '10.5', toMediaTime: '9' });
      const follower = reason === 'follower-correction';
      const accepted = follower && activeRobot && backingRobot && preserve && correction;
      assert.deepEqual(h.events, [...seekPrefix, ...(follower ? ['activeRobot', ...(activeRobot
        ? ['backingRobot', ...(backingRobot ? ['preserve', ...(preserve ? ['correction'] : [])] : [])] : [])] : []),
        ...(accepted ? mapped : destructive.filter(event => event !== seekFailed))]);
      assert.deepEqual(h.state.received, seekInput({ mappedFollowerCorrection: accepted }));
    });
  }

for (const now of [0, 73.5]) test(`actual seek handler takes one clock and context sample: ${now}`, () => {
  const h = fixture({ now }); h.seek(h.socket, { reason: 'follower-correction', fromMediaTime: 10.5, toMediaTime: 9 });
  assert.deepEqual(h.events, [...seekPrefix, 'activeRobot', 'backingRobot', 'preserve', 'correction',
    'offset.reset', 'applied-kind', `playback-rate:${now}`, `begin:${now}`, 'sync', 'source', 'timing']);
  assert.equal(h.state.received?.nowMs, now); assert.equal(h.state.received?.context, context);
});

const helloTrace = ['authorized', 'hello.isActive', 'attach', 'session.active',
  'quality:robot-source-connected', ...resetAndReport];
for (const throwAt of helloTrace) test(`actual hello cannot continue after a synchronous port failure: ${throwAt}`, () => {
  const h = fixture({ throwAt });
  assert.throws(() => h.hello(h.socket, {}), value => value === h.error);
  assert.deepEqual(h.events, helloTrace.slice(0, helloTrace.indexOf(throwAt) + 1));
});
const acceptedSeekTrace = [...seekPrefix, 'activeRobot', 'backingRobot', 'preserve', 'correction', ...mapped];
for (const throwAt of acceptedSeekTrace) test(`actual seek cannot reach subsequent classification or effects after a failure: ${throwAt}`, () => {
  const h = fixture({ throwAt });
  assert.throws(() => h.seek(h.socket, { reason: 'follower-correction', fromMediaTime: 10.5, toMediaTime: 9 }),
    value => value === h.error);
  assert.deepEqual(h.events, acceptedSeekTrace.slice(0, acceptedSeekTrace.indexOf(throwAt) + 1));
});

test('actual SourceRuntime replacement and detach preserve tri-state fencing and generation', () => {
  const source = new SourceRuntime<Socket>({ isConnected: candidate => candidate.readyState === 1 });
  const old: Socket = { readyState: 1 };
  source.attachRobot(old); assert.equal(source.generation, 0);
  const h = fixture({ actualSource: source });
  h.hello(h.socket, {}); assert.equal(source.socket, h.socket); assert.equal(old.isRobotSource, false);
  assert.equal(source.generation, 1); h.events.length = 0;
  h.seek(old, {}); assert.deepEqual(h.events, ['authorized']);
  assert.equal(h.workflow.disconnectSource(old), false); assert.equal(source.generation, 1);
  assert.equal(h.workflow.disconnectSource(h.socket), true); assert.equal(source.generation, 2);
  assert.equal(h.socket.isRobotSource, false); h.events.length = 0;
  h.seek(old, {}); h.seek(h.socket, {}); assert.deepEqual(h.events, ['authorized', 'authorized']);
  assert.equal(source.canReportSeek({ readyState: 1 }), true);
});

test('C1 source lifecycle construction reads no live owner/mapping port or scheduler', () => {
  const poison = new Proxy({}, { get: (_target, key) => { throw new Error(`constructor touched ${String(key)}`); } });
  const dependencies = {
    source: poison, take: poison, mix: poison, offset: poison, timeline: poison,
    calibration: poison, timing: poison, queries: poison, commands: poison, effects: poison,
  } as RelayRobotSourceLifecycleDependencies<Socket>;
  const workflow = createRelayRobotSourceLifecycle(dependencies, poison as RelayRobotSourceMappingMethods);
  assert.deepEqual(Object.keys(workflow), ['activateSource', 'disconnectSource', 'dropLegacyCalibration', 'handleSourceSeek']);
});

test('C1 source composition reuses four original order coordinators and existing mapping commands without state', () => {
  const source = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));
  const code = functionCode(source, 'createRelayRobotSourceLifecycle');
  for (const factory of ['createRelayRobotActivationCoordinator<TSocket>', 'createRelayRobotDisconnectCoordinator<TSocket>',
    'createRelayRobotLegacyCalibrationDropCoordinator', 'createRelaySourceSeekTransactionCoordinator<CalibrationContext>']) {
    assert.ok(code.includes(factory));
  }
  for (const method of ['routeActive', 'clearTransition', 'beginTransition', 'revoke']) assert.ok(code.includes(`mapping.${method}(`));
  assert.doesNotMatch(code, /\b(?:new|async|await|any|ServerContext|setTimeout|setInterval|queueMicrotask|Date|performance)\b/);
  assert.doesNotMatch(code, /queries\.context|Math\.(?:round|floor|ceil)|sourceGeneration|invalidateMapping|discardPrimedContent|canReportSeek|attachRobot/);
});

test('C2 actual root binds the same canonical source, Take, timing, mix and lazy command/query references', () => {
  const h = fixture();
  let bound: Parameters<typeof createRelayRobotMappingOrchestration>[0] | undefined;
  const factory: typeof createRelayRobotMappingOrchestration = dependencies => {
    bound = dependencies; return createRelayRobotMappingOrchestration(dependencies);
  };
  createWorkflow(h.inputs, factory);
  assert.ok(bound);
  assert.equal(bound.source, h.inputs.sourceRuntime); assert.equal(bound.take, h.inputs.takeController);
  assert.equal(bound.mix, h.inputs.session); assert.equal(bound.calibration, h.inputs.calibration);
  assert.equal(bound.timing, h.inputs.timingRuntime); assert.equal(bound.offset, h.inputs.robotPlayerOffset);
  assert.equal(bound.timeline, h.inputs.robotContentTimeline);
  assert.equal(bound.transition, h.inputs.robotContentTransitionRuntime);
  assert.equal(bound.commands.abandonProbeRun, h.inputs.abandonProbeRun);
  assert.equal(bound.queries.bootProbeSettled, h.inputs.bootProbeSettled);
  assert.equal(bound.effects.clearContentValidation, h.inputs.clearContentValidationBaseline);
  assert.deepEqual(h.events, []);
  bound.effects.notifyPreviousReplaced(h.previous); assert.deepEqual(h.events, ['notify']);
});

test('C2 canonical mapping root including source lifecycle is inert, with no getter/clock/command read', () => {
  const poison = new Proxy({}, { get: (_target, key) => { throw new Error(`root constructor touched ${String(key)}`); } });
  const dependencies = { socketOpenState: 1, mixSampleRate: 48_000,
    transitionHistorySamples: 144_000, maxCaptureGapMs: 300,
    backing: poison, source: poison, offset: poison, timeline: poison, calibration: poison,
    validator: poison, timing: poison, transition: poison, mix: poison, take: poison,
    queries: poison, commands: poison, effects: poison,
  } as Parameters<typeof createRelayRobotMappingOrchestration>[0];
  const root = createRelayRobotMappingOrchestration(dependencies);
  for (const key of ['activateSource', 'disconnectSource', 'dropLegacyCalibration', 'handleSourceSeek',
    'commit', 'revoke', 'beginTransition', 'routeActive']) assert.equal(typeof root[key as keyof typeof root], 'function');
});

test('C2 has one canonical source composition and all real callers, retaining tick/Backing wrappers and start order', () => {
  const code = server.text;
  for (const old of ['robotActivationCoordinator', 'robotDisconnectCoordinator',
    'robotLegacyCalibrationDropCoordinator', 'sourceSeekTransactionCoordinator',
    'createRelayRobotActivationCoordinator', 'createRelayRobotDisconnectCoordinator',
    'createRelayRobotLegacyCalibrationDropCoordinator', 'createRelaySourceSeekTransactionCoordinator']) {
    assert.equal(code.includes(old), false, `server must not retain duplicate/dead ${old}`);
  }
  assert.equal((code.match(/const relayRobotMapping =/g) ?? []).length, 1);
  assert.match(functionCode(server, 'dropLegacyCalibrationForRobot'), /relayRobotMapping\.dropLegacyCalibration\(\)/);
  const backing = variableInitializerCode(server, 'backingActivationCoordinator');
  assert.match(backing, /dropLegacyCalibrationForRobot: \(\) => dropLegacyCalibrationForRobot\(\)/);
  const tick = variableInitializerCode(server, 'youtubeTimelineTimer');
  const expiry = tick.indexOf('bootProbeRuntime.takeExpiredRequest(');
  const drop = tick.indexOf('dropLegacyCalibrationForRobot();');
  const sync = tick.indexOf('if (syncAppliedCalibration())', drop);
  assert.ok(expiry >= 0 && drop > expiry && sync > drop);
  assert.ok(tick.indexOf('maybeFinishProbeAnalysis(nowMs)', sync) > sync);
  let previous = -1;
  for (const marker of ['const sourceRuntime =', 'const calibration =', 'const relayRobotMapping =',
    'relayMixPump.start();', 'const youtubeTimelineTimer =', "wss.on('close'",
    'monitorTransport.enableOpus(await loadMonitorOpusEncoder(', 'await webTransportMedia.start(',
    "server.listen(port, '0.0.0.0'", 'async function gracefulShutdown(']) {
    const at = code.indexOf(marker); assert.ok(at > previous, `missing/reordered ${marker}`); previous = at;
  }
});
