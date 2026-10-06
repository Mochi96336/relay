import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CalibrationContext } from '../src/calibration-session.js';
import type { RelayRobotContentTransitionCommitPlan } from '../src/relay-robot-content-transition-commit-coordinator.js';
import { RobotContentTransitionRuntime,
  type RobotContentTransitionRuntimeHost } from '../src/robot-content-transition-runtime.js';
import { createRelayRobotMappingCommit, createRelayRobotMappingOrchestration,
  type RelayRobotMappingCommitDependencies } from '../src/relay-robot-mapping-orchestration.js';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
const context: CalibrationContext = { sessionGeneration: 3, micGeneration: 4, backingGeneration: 5,
  micSourceRate: 48_000, backingSourceRate: 48_000, sourceGeneration: 9 };
const preA = new Int16Array([1, 2]), preB = new Int16Array([3]), postA = new Int16Array([4, 5]);
const postB = new Int16Array([6]), postC = new Int16Array([7, 8]);
type Plan = RelayRobotContentTransitionCommitPlan<CalibrationContext>;
type Workflow = { commit(plan: Plan, nowMs: number): boolean };

// Execute the actual canonical server initializer and runtime host callback.
// Unused owners reject all reads; no commit algorithm is copied here.
function productionPorts(inputs: object,
  factory: (dependencies: Parameters<typeof createRelayRobotMappingOrchestration>[0]) => ReturnType<typeof createRelayRobotMappingOrchestration>
    = createRelayRobotMappingOrchestration) {
  const unexpected = () => { throw new Error('commit must not query unrelated server ports'); };
  const owner = () => new Proxy({}, { get: unexpected });
  return { ...inputs, createRelayRobotMappingOrchestration: factory,
    WebSocket: { OPEN: 1 }, MIX_SAMPLE_RATE: 48_000,
    ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES: 144_000, MAX_CAPTURE_GAP_MS: 300,
    backingRuntime: owner(), sourceRuntime: owner(), robotPlayerOffset: owner(),
    timingRuntime: owner(), robotContentTransitionRuntime: owner(), session: owner(),
    takeController: owner(), bootProbeSettled: unexpected, abandonProbeRun: unexpected,
    calibrationContext: unexpected, appliedCalibrationKind: unexpected,
    calibrationIsStale: unexpected, currentPlaybackRate: unexpected,
    clearContentValidationBaseline: unexpected, syncAppliedCalibration: unexpected,
    broadcastJson: unexpected, sourceStatusPayload: unexpected,
    timingCalibrationStatusPayload: unexpected, sendJson: unexpected };
}

function createWorkflow(inputs: object): Workflow {
  const initializer = variableInitializerCode(server, 'relayRobotMapping');
  const runtime = variableInitializerCode(server, 'robotContentTransitionRuntime');
  const callback = runtime.match(/commit: (\(plan, nowMs\) => relayRobotMapping\.commit\(plan, nowMs\))/)?.[1];
  assert.ok(callback, 'actual host commit callback must remain identifiable');
  const ports = productionPorts(inputs);
  return new Function(...Object.keys(ports), `const relayRobotMapping = ${initializer};
    return { commit: ${callback} };`)(...Object.values(ports)) as Workflow;
}

function fixture(options: { accepted?: boolean; collecting?: boolean; throwAt?: string } = {}) {
  const events: string[] = [], fed: { samples: Int16Array; start: number; now: number }[] = [];
  const error = new Error('original synchronous commit effect failure');
  const note = (event: string) => { events.push(event); if (event === options.throwAt) throw error; };
  const inputs = {
    robotContentTimeline: {
      noteBackingBoundary: (boundary: number, actual: CalibrationContext, now: number) => {
        assert.equal(actual, context); note(`boundary:${boundary}:${now}`); return options.accepted !== false;
      },
      mapBackingStart: (start: number, actual: CalibrationContext, now: number) => {
        assert.equal(actual, context); note(`map:${start}:${now}`);
        return start === 10 ? 0 : start === 20 ? null : 100;
      },
    },
    calibration: { restartWorkingEvidence: (now: number) => { note(`restart:${now}`); } },
    contentCalibrationValidator: {
      get collecting() { note('validator'); return options.collecting === true; },
      cancel: (now: number) => { note(`cancel:${now}`); },
    },
    feedContentBackingEvidence: (samples: Int16Array, start: number, now: number) => {
      const name = samples === preA ? 'preA' : samples === preB ? 'preB'
        : samples === postA ? 'postA' : samples === postB ? 'postB' : 'postC';
      note(`feed:${name}:${start}:${now}`); fed.push({ samples, start, now });
    },
  };
  return { workflow: createWorkflow(inputs), inputs, events, fed, error };
}

function plan(discardWorkingEvidence = false): Plan {
  return { context, boundarySample: 17, discardWorkingEvidence,
    confirmedPreChunks: [{ start: -3, samples: preA }, { start: 0, samples: preB }],
    postChunks: [{ start: 10, samples: postA }, { start: 20, samples: postB }, { start: 30, samples: postC }] };
}

test('actual commit composition is inert and exposes only synchronous host commit', () => {
  const h = fixture(); assert.deepEqual(h.events, []); assert.deepEqual(Object.keys(h.workflow), ['commit']);
});

for (const discard of [false, true]) test(`actual boundary refusal has no calibration or evidence effects: ${discard}`, () => {
  const h = fixture({ accepted: false, collecting: true });
  assert.equal(h.workflow.commit(plan(discard), 0), false);
  assert.deepEqual(h.events, ['boundary:17:0']); assert.deepEqual(h.fed, []);
});

for (const discard of [false, true]) for (const collecting of [false, true]) for (const now of [0, 73.5]) {
  test(`actual commit preserves discard guard, sampling and pre/post evidence: ${discard}/${collecting}/${now}`, () => {
    const h = fixture({ collecting }), input = plan(discard);
    const before = { ...input, confirmedPreChunks: [...input.confirmedPreChunks], postChunks: [...input.postChunks] };
    assert.equal(h.workflow.commit(input, now), true);
    assert.deepEqual(h.events, [`boundary:17:${now}`,
      ...(discard ? [`restart:${now}`, 'validator', ...(collecting ? [`cancel:${now}`] : [])] : []),
      `feed:preA:-3:${now}`, `feed:preB:0:${now}`, `map:10:${now}`, `feed:postA:0:${now}`,
      `map:20:${now}`, `map:30:${now}`, `feed:postC:100:${now}`]);
    assert.deepEqual(h.fed, [{ samples: preA, start: -3, now }, { samples: preB, start: 0, now },
      { samples: postA, start: 0, now }, { samples: postC, start: 100, now }]);
    assert.equal(h.fed[0].samples, preA); assert.equal(h.fed[2].samples, postA);
    assert.equal(input.context, context); assert.deepEqual(input, before);
    assert.deepEqual(Array.from(postB), [6]);
  });
}

for (const collecting of [false, true]) test(`empty evidence still performs the admitted discard transaction: ${collecting}`, () => {
  const h = fixture({ collecting }), input = { ...plan(true), confirmedPreChunks: [], postChunks: [] };
  assert.equal(h.workflow.commit(input, 0), true);
  assert.deepEqual(h.events, ['boundary:17:0', 'restart:0', 'validator', ...(collecting ? ['cancel:0'] : [])]);
});

const fullDiscardTrace = ['boundary:17:0', 'restart:0', 'validator', 'cancel:0', 'feed:preA:-3:0',
  'feed:preB:0:0', 'map:10:0', 'feed:postA:0:0', 'map:20:0', 'map:30:0', 'feed:postC:100:0'];
for (const throwAt of fullDiscardTrace) test(`actual synchronous exception cuts off later commit effects: ${throwAt}`, () => {
  const h = fixture({ collecting: true, throwAt });
  assert.throws(() => h.workflow.commit(plan(true), 0), value => value === h.error);
  assert.deepEqual(h.events, fullDiscardTrace.slice(0, fullDiscardTrace.indexOf(throwAt) + 1));
});

test('C1 commit boundary does not read live owner truth or effects at construction', () => {
  const forbidden = new Proxy({}, { get: (_target, key) => { throw new Error(`unexpected constructor read: ${String(key)}`); } });
  const boundary = createRelayRobotMappingCommit({
    timeline: forbidden as RelayRobotMappingCommitDependencies['timeline'],
    calibration: forbidden as RelayRobotMappingCommitDependencies['calibration'],
    validator: forbidden as RelayRobotMappingCommitDependencies['validator'],
    effects: forbidden as RelayRobotMappingCommitDependencies['effects'],
  });
  assert.deepEqual(Object.keys(boundary), ['commit']);
});

test('C1 commit boundary owns no domain state, scheduling, admission, context or clock sampling', () => {
  const source = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));
  const code = functionCode(source, 'createRelayRobotMappingCommit');
  assert.doesNotMatch(code, /\b(?:new|async|await|any|ServerContext|setTimeout|setInterval|queueMicrotask)\b/);
  assert.doesNotMatch(code, /performance|Date\.now|queries\.context|Math\.(?:round|floor|ceil)|confirmedRevision|sourceGeneration/);
  assert.match(code, /createRelayRobotContentTransitionCommitCoordinator<CalibrationContext>/);
});

test('C2 actual server root binds the canonical owners and original evidence feeder without reads', () => {
  const h = fixture();
  let bound: Parameters<typeof createRelayRobotMappingOrchestration>[0] | undefined;
  const ports = productionPorts(h.inputs, (dependencies: Parameters<typeof createRelayRobotMappingOrchestration>[0]) => {
    bound = dependencies;
    return createRelayRobotMappingOrchestration(dependencies);
  });
  new Function(...Object.keys(ports), `return ${variableInitializerCode(server, 'relayRobotMapping')};`)(...Object.values(ports));
  assert.ok(bound);
  assert.equal(bound.timeline, h.inputs.robotContentTimeline);
  assert.equal(bound.calibration, h.inputs.calibration);
  assert.equal(bound.validator, h.inputs.contentCalibrationValidator);
  assert.equal(bound.effects.feedBackingEvidence, h.inputs.feedContentBackingEvidence);
  assert.equal(bound.backing, ports.backingRuntime);
  assert.equal(bound.source, ports.sourceRuntime);
  assert.equal(bound.offset, ports.robotPlayerOffset);
  assert.equal(bound.timing, ports.timingRuntime);
  assert.equal(bound.transition, ports.robotContentTransitionRuntime);
  assert.equal(bound.mix, ports.session);
  assert.equal(bound.queries.context, ports.calibrationContext);
  assert.equal(bound.queries.appliedKind, ports.appliedCalibrationKind);
  assert.equal(bound.queries.calibrationIsStale, ports.calibrationIsStale);
  assert.equal(bound.queries.currentPlaybackRate, ports.currentPlaybackRate);
  assert.equal(bound.effects.clearContentValidation, ports.clearContentValidationBaseline);
  assert.deepEqual(h.events, []);
});

test('C2 actual transition runtime constructor does not invoke the late-bound host or start work', () => {
  const host = new Proxy({}, { get: (_target, key) => { throw new Error(`unexpected constructor host read: ${String(key)}`); } });
  const runtime = new RobotContentTransitionRuntime({ sampleRate: 48_000,
    historySamples: 144_000, windowSamples: 31_200, maxLagMs: 1_000,
    maxEvidenceGapMs: 300, toleranceMs: 5, retentionSamples: 480_000,
    bounds: { lifetimeMs: 10_000, maxWindows: 4, maxWorkerFailures: 3 },
    host: host as RobotContentTransitionRuntimeHost,
    now: () => { throw new Error('constructor must not sample clock'); },
    estimateRawLag: () => { throw new Error('constructor must not start worker'); },
    compareHypotheses: () => { throw new Error('constructor must not start worker'); },
  });
  assert.equal(runtime.quarantined, false);
});

test('C2 has one mapping root before all starts and preserves server lifecycle order', () => {
  const code = server.text;
  assert.doesNotMatch(code, /robotContentTransitionCommitCoordinator|import.*createRelayRobotContentTransitionCommitCoordinator/);
  assert.equal((code.match(/const relayRobotMapping =/g) ?? []).length, 1);
  const ordered = ['const robotContentTransitionRuntime =', 'const relayRobotMapping =',
    'relayMixPump.start();', 'const youtubeTimelineTimer =', "wss.on('close'",
    'monitorTransport.enableOpus(await loadMonitorOpusEncoder(',
    'await webTransportMedia.start(', "server.listen(port, '0.0.0.0'", 'async function gracefulShutdown('];
  let previous = -1;
  for (const marker of ordered) {
    const index = code.indexOf(marker);
    assert.ok(index > previous, `missing or reordered lifecycle marker: ${marker}`);
    previous = index;
  }
  const shutdown = functionCode(server, 'gracefulShutdown');
  previous = -1;
  for (const marker of ['relayMixPump.stop()', 'await takeController.shutdown(',
    'await webTransportMedia.stop()', 'wss.close(', 'server.close(']) {
    const index = shutdown.indexOf(marker);
    assert.ok(index > previous, `missing or reordered shutdown marker: ${marker}`);
    previous = index;
  }
});
