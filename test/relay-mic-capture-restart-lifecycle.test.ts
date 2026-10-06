import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { PcmFrame } from '../src/pcm-frame.js';
import type { RelayMicCaptureRestartInput } from '../src/relay-mic-capture-restart-coordinator.js';
import { createRelayMixPump } from '../src/relay-mix-pump.js';
import { createRelayMicCaptureRestartLifecycle, createRelayMicLifecycle,
  type RelayMicCaptureRestartLifecycleDependencies } from '../src/relay-mic-lifecycle.js';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
type Workflow = { restart(input: RelayMicCaptureRestartInput): void };
type RootDependencies = Parameters<typeof createRelayMicLifecycle>[0];
type Root = ReturnType<typeof createRelayMicLifecycle>;

// Execute the actual canonical root and pump initializers, not copied algorithms.
function productionPorts(inputs: object, factory: (dependencies: RootDependencies) => Root = createRelayMicLifecycle) {
  const unexpected = () => { throw new Error('restart must not query an unrelated lifecycle port'); };
  const owner = () => new Proxy({}, { get: unexpected });
  return { ...inputs, createRelayMicLifecycle: factory,
    participants: owner(), micTransportGrace: owner(), backingRuntime: owner(),
    participantPayload: unexpected, applyMicOwnerEffects: unexpected, invalidateMicTiming: unexpected,
    clearRobotContentTransition: unexpected, refreshLiveMicNetworkCompensation: unexpected,
    cancelActiveContentValidation: unexpected, stopLiveSource: unexpected,
    beginPreparedSongHandoff: unexpected, retireSocket: unexpected, sendJson: unexpected,
    mixSettingsPayload: unexpected, youtubeTimeline: owner(), roomSongCommandStatusPayload: unexpected,
    broadcastStatus: unexpected, broadcastSessionStatus: unexpected };
}

function createWorkflow(inputs: object): Workflow {
  const ports = productionPorts(inputs);
  const initializer = variableInitializerCode(server, 'relayMicLifecycle').replace('<RelaySocket>', '');
  const root = new Function(...Object.keys(ports), `return ${initializer};`)(...Object.values(ports)) as Root;
  return { restart: root.restartCapture };
}

function actualPump(inputs: object, workflow: Workflow) {
  const ports = { ...inputs, relayMicLifecycle: { restartCapture: workflow.restart }, createRelayMixPump };
  return new Function(...Object.keys(ports), `return ${variableInitializerCode(server, 'relayMixPump')};`)
    (...Object.values(ports)) as ReturnType<typeof createRelayMixPump>;
}

const failEvent = 'fail:Microphone capture restarted during calibration. Start calibration again.';
const idleTrace = ['quality:mic-capture-restarted', 'abandon', 'clear-baseline', 'sync', 'timing', 'source'];
const collectingTrace = ['quality:mic-capture-restarted', 'abandon', 'clear-baseline', failEvent];

function fixture(options: { collecting?: boolean; throwAt?: string; qualityCollecting?: boolean;
  resetCollecting?: boolean; captureRestarted?: boolean; empty?: boolean; now?: number;
  noTransport?: boolean; noRate?: boolean } = {}) {
  const events: string[] = [];
  const error = new Error('original synchronous Mic restart effect failure');
  const state = { collecting: options.collecting === true };
  const now = options.now ?? 0;
  const samples = new Int16Array(options.empty ? [] : [3, 5]);
  const frame: PcmFrame = { generation: 9, firstSampleIndex: 0, pcm: Buffer.from([3, 0, 5, 0]) };
  const note = (event: string) => { events.push(event); if (options.throwAt === event) throw error; };
  const consume = (event: string, actual: Int16Array, start: number) => {
    assert.equal(actual, samples); assert.equal(start, -2); note(event);
  };
  const unexpected = () => { throw new Error('restart must not invoke an unrelated server port'); };
  const inputs = {
    performance: { now: () => { note(`clock:${now}`); return now; } },
    takeController: { noteQualityEvent: (event: string) => {
      note(`quality:${event}`);
      if (options.qualityCollecting !== undefined) state.collecting = options.qualityCollecting;
    }, append: unexpected },
    abandonProbeRun: () => note('abandon'),
    clearContentValidationBaseline: () => note('clear-baseline'),
    calibration: {
      get collecting() { note('collecting'); return state.collecting; },
      fail: (message: string) => note(`fail:${message}`),
      primeMic: (actual: Int16Array, start: number) => consume('prime', actual, start),
      observeMic: (actual: Int16Array, start: number) => consume('calibration', actual, start),
    },
    syncAppliedCalibration: () => note('sync'),
    broadcastJson: (payload: { type: string }) => note(payload.type),
    timingCalibrationStatusPayload: () => ({ type: 'timing' }),
    sourceStatusPayload: () => ({ type: 'source' }),
    session: {
      get active() { note('mix.active'); return true; },
      ingestMic: (actual: PcmFrame, rate: number, actualNow: number) => {
        assert.equal(actual, frame); assert.equal(rate, 48_000); assert.equal(actualNow, now);
        note(`ingest:${now}`);
        return { samples, start: -2, captureRestarted: options.captureRestarted !== false };
      },
    },
    micRuntime: {
      get audioTransport() { note('mic.transport'); return options.noTransport ? null : {}; },
      get sampleRate() { note('mic.rate'); return options.noRate ? null : 48_000; },
      noteFrame: (actualNow: number, actual: PcmFrame) => {
        assert.equal(actual, frame); assert.equal(actualNow, now); note(`flow:${now}`);
      },
    },
    micAudibility: { observeReceived: (actual: Int16Array) => {
      assert.equal(actual, samples); note('audibility.received');
    } },
    micLevel: { observeReceived: (actual: Int16Array) => {
      assert.equal(actual, samples); note('level.received');
    }, reset: () => note('level.reset') },
    micClockDrift: { observe: (generation: number, rate: number, end: number, actualNow: number) => {
      assert.equal(generation, 9); assert.equal(rate, 48_000); assert.equal(end, 2); assert.equal(actualNow, now);
      note(`drift:${now}`); return false;
    } },
    resetMicAudibility: () => {
      note('audibility.reset');
      if (options.resetCollecting !== undefined) state.collecting = options.resetCollecting;
    },
    contentCalibrationValidator: { observeMic: (actual: Int16Array, start: number) => consume('validator', actual, start) },
    robotContentTransitionRuntime: { noteMicProgress: () => note('transition') },
    robotContentFallbackPrimingActive: () => { note('fallback'); return true; },
    monitorTransport: { broadcast: unexpected }, startLiveSource: unexpected,
    takeQualityFrameState: unexpected, micPlayable: unexpected, roomSongPlaying: unexpected,
    reportMicAudibility: unexpected, reportMicLevel: unexpected, reportMicTimelineFolds: unexpected,
  };
  const workflow = createWorkflow(inputs);
  return { workflow, pump: actualPump(inputs, workflow), inputs, state, events, error, frame, samples };
}

function pumpPrefix(empty: boolean, now: number, restart = true) {
  return ['mic.transport', 'mic.rate', 'mix.active', `clock:${now}`, 'mic.rate', `ingest:${now}`,
    ...(!empty ? [`flow:${now}`] : []), 'audibility.received', 'level.received', 'mic.rate', `drift:${now}`,
    ...(restart ? ['audibility.reset', 'level.reset', 'collecting'] : [])];
}
const consumers = ['fallback', 'prime', 'calibration', 'validator', 'transition'];

test('actual restart composition and actual pump construction are inert', () => {
  const h = fixture(); assert.deepEqual(h.events, []); assert.deepEqual(Object.keys(h.workflow), ['restart']);
});

for (const collecting of [false, true]) test(`actual restart preserves synchronous void and literal branch trace: ${collecting}`, () => {
  const h = fixture({ collecting }), input = { calibrationCollecting: collecting };
  assert.equal(h.workflow.restart(input), undefined);
  assert.deepEqual(h.events, collecting ? collectingTrace : idleTrace);
  assert.deepEqual(input, { calibrationCollecting: collecting });
});

for (const passed of [false, true]) for (const changed of [false, true]) {
  test(`restart honors passed admission truth without rereading a mutated owner: ${passed}/${changed}`, () => {
    const h = fixture({ collecting: !passed, qualityCollecting: changed });
    h.workflow.restart({ calibrationCollecting: passed });
    assert.deepEqual(h.events, passed ? collectingTrace : idleTrace);
    assert.equal(h.state.collecting, changed);
  });
}

for (const collecting of [false, true]) for (const throwAt of collecting ? collectingTrace : idleTrace) {
  test(`actual restart propagates the original exception and cuts off later effects: ${collecting}/${throwAt}`, () => {
    const h = fixture({ collecting, throwAt }), trace = collecting ? collectingTrace : idleTrace;
    assert.throws(() => h.workflow.restart({ calibrationCollecting: collecting }), value => value === h.error);
    assert.deepEqual(h.events, trace.slice(0, trace.indexOf(throwAt) + 1));
  });
}

for (const collecting of [false, true]) for (const empty of [false, true]) for (const now of [0, 73.5]) {
  test(`actual production pump settles restart before all replacement PCM consumers: ${collecting}/${empty}/${now}`, () => {
    const h = fixture({ collecting, empty, now });
    assert.equal(h.pump.ingest(h.frame), undefined);
    assert.deepEqual(h.events, [...pumpPrefix(empty, now), ...(collecting ? collectingTrace : idleTrace), ...consumers]);
    assert.equal(h.events.filter(event => event === 'collecting').length, 1);
  });
}

for (const collecting of [false, true]) for (const empty of [false, true]) {
  test(`actual pump does not query collecting or restart without capture change: ${collecting}/${empty}`, () => {
    const h = fixture({ collecting, empty, captureRestarted: false }); h.pump.ingest(h.frame);
    assert.deepEqual(h.events, [...pumpPrefix(empty, 0, false), ...consumers]);
  });
}

for (const collecting of [false, true]) test(`actual pump samples collecting after reset, not at constructor or ingest admission: ${collecting}`, () => {
  const h = fixture({ collecting: !collecting, resetCollecting: collecting }); h.pump.ingest(h.frame);
  assert.deepEqual(h.events, [...pumpPrefix(false, 0), ...(collecting ? collectingTrace : idleTrace), ...consumers]);
});

for (const collecting of [false, true]) for (const throwAt of collecting ? collectingTrace : idleTrace) {
  test(`actual pump preserves restart exception and never advances later PCM consumers: ${collecting}/${throwAt}`, () => {
    const h = fixture({ collecting, throwAt }), trace = collecting ? collectingTrace : idleTrace;
    assert.throws(() => h.pump.ingest(h.frame), value => value === h.error);
    assert.deepEqual(h.events, [...pumpPrefix(false, 0), ...trace.slice(0, trace.indexOf(throwAt) + 1)]);
  });
}

test('actual pump without media transport has no restart or PCM effects', () => {
  const h = fixture({ noTransport: true }); h.pump.ingest(h.frame); assert.deepEqual(h.events, ['mic.transport']);
});
test('actual pump without sample rate has no restart or PCM effects', () => {
  const h = fixture({ noRate: true }); h.pump.ingest(h.frame); assert.deepEqual(h.events, ['mic.transport', 'mic.rate']);
});

test('C1 Mic capture restart construction reads no owner, command, effect or scheduler', () => {
  const forbidden = new Proxy({}, { get: (_target, key) => { throw new Error(`unexpected constructor read: ${String(key)}`); } });
  const boundary = createRelayMicCaptureRestartLifecycle({
    take: forbidden as RelayMicCaptureRestartLifecycleDependencies['take'],
    calibration: forbidden as RelayMicCaptureRestartLifecycleDependencies['calibration'],
    commands: forbidden as RelayMicCaptureRestartLifecycleDependencies['commands'],
    effects: forbidden as RelayMicCaptureRestartLifecycleDependencies['effects'],
  });
  assert.deepEqual(Object.keys(boundary), ['restartCapture']);
});

test('C1 Mic restart boundary reuses original order authority without sampling or state', () => {
  const module = parseTypeScriptSource(new URL('../src/relay-mic-lifecycle.ts', import.meta.url),
    readFileSync(new URL('../src/relay-mic-lifecycle.ts', import.meta.url), 'utf8'));
  const code = functionCode(module, 'createRelayMicCaptureRestartLifecycle');
  assert.match(code, /createRelayMicCaptureRestartCoordinator\(\{/);
  assert.doesNotMatch(code, /\b(?:new|async|await|any|ServerContext|setTimeout|setInterval|queueMicrotask)\b/);
  assert.doesNotMatch(code, /\.collecting|calibrationCollecting|performance|Date\.now|Math\.(?:round|floor|ceil)|generation|timer|scheduler/);
});

test('C2 actual canonical Mic root and pump bind the same owners, commands and restart method inertly', () => {
  const h = fixture();
  let bound: RootDependencies | undefined;
  let pumpBound: Parameters<typeof createRelayMixPump>[0] | undefined;
  const ports = { ...productionPorts(h.inputs, dependencies => {
    bound = dependencies; return createRelayMicLifecycle(dependencies);
  }), createRelayMixPump: (dependencies: Parameters<typeof createRelayMixPump>[0]) => {
    pumpBound = dependencies; return createRelayMixPump(dependencies);
  } };
  const rootCode = variableInitializerCode(server, 'relayMicLifecycle').replace('<RelaySocket>', '');
  const pumpCode = variableInitializerCode(server, 'relayMixPump');
  const actual = new Function(...Object.keys(ports), `const relayMicLifecycle = ${rootCode};
    return { root: relayMicLifecycle, pump: ${pumpCode} };`)(...Object.values(ports)) as { root: Root };
  assert.ok(bound); assert.ok(pumpBound);
  assert.equal(bound.take, h.inputs.takeController);
  assert.equal(bound.calibration, h.inputs.calibration);
  assert.equal(bound.mix, h.inputs.session);
  assert.equal(bound.mic, h.inputs.micRuntime);
  assert.equal(bound.participants, ports.participants);
  assert.equal(bound.grace, ports.micTransportGrace);
  assert.equal(bound.backing, ports.backingRuntime);
  assert.equal(bound.commands.abandonProbeRun, h.inputs.abandonProbeRun);
  assert.equal(bound.commands.clearContentValidationBaseline, h.inputs.clearContentValidationBaseline);
  assert.equal(bound.commands.syncAppliedCalibration, h.inputs.syncAppliedCalibration);
  assert.equal(pumpBound.restart.restart, actual.root.restartCapture);
  assert.equal(pumpBound.mix, bound.mix); assert.equal(pumpBound.mic, bound.mic);
  assert.equal(pumpBound.calibration, bound.calibration); assert.equal(pumpBound.take, bound.take);
  assert.deepEqual(h.events, []);
});

test('C2 has one Mic root before pump start and preserves server startup/shutdown order', () => {
  const code = server.text;
  assert.doesNotMatch(code, /micCaptureRestartCoordinator|import.*createRelayMicCaptureRestartCoordinator/);
  assert.equal((code.match(/const relayMicLifecycle =/g) ?? []).length, 1);
  let previous = -1;
  for (const marker of ['const relayMicLifecycle =', 'const relayMixPump =', 'relayMixPump.start();',
    'const youtubeTimelineTimer =', "wss.on('close'", 'monitorTransport.enableOpus(await loadMonitorOpusEncoder(',
    'await webTransportMedia.start(', "server.listen(port, '0.0.0.0'", 'async function gracefulShutdown(']) {
    const index = code.indexOf(marker);
    assert.ok(index > previous, `missing or reordered lifecycle marker: ${marker}`); previous = index;
  }
  const shutdown = functionCode(server, 'gracefulShutdown');
  previous = -1;
  for (const marker of ['relayMixPump.stop()', 'await takeController.shutdown(',
    'await webTransportMedia.stop()', 'wss.close(', 'server.close(']) {
    const index = shutdown.indexOf(marker);
    assert.ok(index > previous, `missing or reordered shutdown marker: ${marker}`); previous = index;
  }
});
