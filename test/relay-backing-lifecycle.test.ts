import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { PcmFrame } from '../src/pcm-frame.js';
import { BackingRuntime } from '../src/backing-runtime.js';
import type { RelayBackingActivationInput } from '../src/relay-backing-activation-coordinator.js';
import type { RelayBackingCaptureRestartInput } from '../src/relay-backing-capture-restart-coordinator.js';
import type { RelayBackingGraceExpiryInput } from '../src/relay-backing-grace-expiry-coordinator.js';
import { createRelayAudioUplinkCoordinator } from '../src/relay-audio-uplink-coordinator.js';
import { createRelayBackingLifecycle, type RelayBackingLifecycleDependencies } from '../src/relay-backing-lifecycle.js';
import { functionCode, objectArrowCallbackCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
type Socket = { id: string; sampleRate?: number; role?: string; replaced?: boolean; participantConnectionId?: string };
type Workflow = {
  activate(input: RelayBackingActivationInput<Socket>): void;
  restartCapture(input: RelayBackingCaptureRestartInput): void;
  disconnect(socket: Socket): boolean;
  expireGrace(input: RelayBackingGraceExpiryInput): 'stopped' | 'voice-only';
};

// C2 runs the actual canonical root and true callers. C0/C1 source archives
// preserve the old boundary; all fixed traces remain unchanged.
function createWorkflow(inputs: object,
  factory: (d: RelayBackingLifecycleDependencies<Socket>) => Workflow = createRelayBackingLifecycle): Workflow {
  const ports = { ...inputs, createRelayBackingLifecycle: factory };
  return new Function(...Object.keys(ports),
    `return ${variableInitializerCode(server, 'relayBackingLifecycle').replace('<RelaySocket>', '')};`)
    (...Object.values(ports)) as Workflow;
}

function actualRegistration(inputs: object, workflow: Workflow) {
  const ports = { ...inputs, relayBackingLifecycle: { activate: workflow.activate } };
  return new Function(...Object.keys(ports),
    `return ({${objectArrowCallbackCode(server, 'registrationProtocol', 'backing')}}).backing;`)
    (...Object.values(ports)) as (socket: Socket, payload: Record<string, unknown>) => void;
}

function actualUplink(inputs: object, workflow: Workflow) {
  const ports = { ...inputs, createRelayAudioUplinkCoordinator,
    relayBackingLifecycle: { restartCapture: workflow.restartCapture } };
  return new Function(...Object.keys(ports),
    `return ${variableInitializerCode(server, 'audioUplinkCoordinator').replace('<RelaySocket>', '')};`)
    (...Object.values(ports)) as ReturnType<typeof createRelayAudioUplinkCoordinator<Socket>>;
}

function actualGrace(inputs: object, workflow: Workflow) {
  const ports = { ...inputs, relayBackingLifecycle: { expireGrace: workflow.expireGrace } };
  return new Function(...Object.keys(ports), `${functionCode(server, 'expireBackingGrace')}; return expireBackingGrace;`)
    (...Object.values(ports)) as () => void;
}

const restartFail = 'fail:Backing capture restarted during calibration. Start calibration again.';
const disconnectFail = 'fail:Desktop Source disconnected during calibration.';
const timingReason = 'invalidate:Backing route ended while the room continued voice-only.';
const restartIdle = ['clear', 'quality:backing-capture-restarted', 'abandon', 'baseline', 'sync', 'timing', 'source'];
const restartCollecting = ['clear', 'quality:backing-capture-restarted', 'abandon', 'baseline', restartFail];
const voiceOnly = ['route.retire', 'clear', timingReason, 'status'];

type Options = {
  previous?: 'none' | 'same' | 'other'; active?: boolean; collecting?: boolean;
  collectingAfterDrop?: boolean; collectingAfterAbandon?: boolean; collectingAfterDetach?: boolean;
  current?: boolean; cancel?: boolean; throwAt?: string;
  control?: boolean; wt?: boolean; grace?: boolean; song?: boolean;
  captureRestarted?: boolean; generationChanged?: boolean; previousGeneration?: number | null;
  empty?: boolean; now?: number; mapped?: number | null; mic?: boolean;
  authorized?: boolean; roleAllowed?: boolean; captureReplaced?: boolean;
  actualBacking?: BackingRuntime<Socket>;
};

function fixture(options: Options = {}) {
  const events: string[] = [], error = new Error('original synchronous Backing lifecycle failure');
  const state = { collecting: options.collecting === true, bound: null as Socket | null,
    robot: false, generationReads: 0, sampleRate: undefined as number | undefined };
  const note = (event: string) => { events.push(event); if (event === options.throwAt) throw error; };
  const socket: Socket = { id: 'next', role: 'backing',
    get sampleRate() { return state.sampleRate; },
    set sampleRate(value) { note(`rate:${value}`); state.sampleRate = value; } };
  const other: Socket = { id: 'old' };
  state.bound = options.previous === 'same' ? socket : options.previous === 'other' ? other : null;
  const frame: PcmFrame = { generation: 8, firstSampleIndex: 0, pcm: Buffer.from([3, 0, 5, 0]) };
  const samples = new Int16Array(options.empty ? [] : [3, 5]), data = Buffer.from([7, 9]);
  const now = options.now ?? 0;
  const unexpected = () => { throw new Error('an unrelated Backing lifecycle port was touched'); };
  const backingRuntime = options.actualBacking ?? {
    get socket() { note('previous'); return state.bound; },
    get sampleRate() { note('backing.rate'); return 48_000; },
    get isRobot() { note('backing.robot'); return state.robot; },
    isSocket: (candidate: Socket) => { assert.equal(candidate, socket); note('current'); return options.current !== false; },
    bind: (input: { socket: Socket; sampleRate: number; robot: boolean }) => {
      assert.equal(input.socket, socket); assert.equal(socket.sampleRate, input.sampleRate);
      note(`bind:${input.sampleRate}:${input.robot}`); state.bound = input.socket; state.robot = input.robot;
      return { previous: other, sameSocket: false };
    },
    detach: (candidate: Socket) => {
      assert.equal(candidate, socket); note('detach'); state.bound = null;
      if (options.collectingAfterDetach !== undefined) state.collecting = options.collectingAfterDetach;
      return true;
    },
    retireRobotRoute: () => { note('route.retire'); state.robot = false; },
    noteFrame: (candidate: Socket, actualNow: number) => {
      assert.equal(candidate, socket); assert.equal(actualNow, now); note(`flow:${now}`); return true;
    },
  };
  const inputs = {
    backingRuntime,
    clearRobotContentTransition: () => note('clear'),
    takeController: { noteQualityEvent: (event: string) => { note(`quality:${event}`); return true; } },
    replacePrevious: (previous: Socket | null, next: Socket, reason: string) => {
      assert.equal(next, socket); assert.equal(reason, 'Replaced by a newer tab capture.');
      note(`retire:${previous?.id ?? 'none'}->${next.id}`);
    },
    session: {
      get active() { note('active'); return options.active !== false; },
      retireBackingCapture: () => note('retire.capture'),
      setBackingExpected: (value: boolean) => note(`expected:${value}`),
      get backingGeneration() {
        note('generation'); state.generationReads += 1;
        return state.generationReads > 1 && options.generationChanged ? 8 : options.previousGeneration === undefined ? 7 : options.previousGeneration;
      },
      ingestBacking: (actual: PcmFrame, rate: number, actualNow: number, robot: boolean) => {
        assert.equal(actual, frame); assert.equal(rate, 48_000); assert.equal(actualNow, now);
        assert.equal(robot, state.robot); note(`ingest:${now}`);
        return { samples, start: -2, captureRestarted: options.captureRestarted === true };
      },
      backingCaptureReplacedBy: (identity: { generation: number; sourceRate: number; sampleCursor: number }) => {
        assert.deepEqual(identity, { generation: 8, sourceRate: 48_000, sampleCursor: 0 });
        note('replacement.detect'); return options.captureReplaced === true;
      },
    },
    calibration: {
      get collecting() { note('collecting'); return state.collecting; },
      fail: (message: string) => note(`fail:${message}`),
    },
    abandonProbeRun: () => {
      note('abandon'); if (options.collectingAfterAbandon !== undefined) state.collecting = options.collectingAfterAbandon;
    },
    clearContentValidationBaseline: () => note('baseline'),
    cancelActiveContentValidation: () => { note('cancel'); return options.cancel === true; },
    syncAppliedCalibration: () => { note('sync'); return true; },
    broadcastJson: (payload: { type: string }) => note(payload.type),
    timingCalibrationStatusPayload: () => ({ type: 'timing' }),
    sourceStatusPayload: () => ({ type: 'source' }),
    broadcastStatus: () => note('status'),
    dropLegacyCalibrationForRobot: () => {
      note('drop'); if (options.collectingAfterDrop !== undefined) state.collecting = options.collectingAfterDrop;
    },
    sendJson: (candidate: Socket, payload: Record<string, unknown>) => {
      assert.equal(candidate, socket);
      if (payload.type === 'error') {
        assert.ok(['Invalid backing sample rate.',
          'Backing capture identity requires generation and sample cursor together.',
          'Invalid backing capture identity.'].includes(String(payload.message)));
        note(`error:${payload.message}`); return;
      }
      assert.equal(payload.type, 'registered'); assert.equal(payload.role, 'backing');
      note(`registered:${payload.robot}`);
    },
    startLiveSource: () => note('start'), stopLiveSource: () => note('stop'),
    invalidateMicTiming: (message: string) => note(`invalidate:${message}`),
    micRuntime: { controlConnected: () => { note('mic.control'); return options.control === true; },
      isPublisher: (candidate: Socket) => { assert.equal(candidate, socket); note('mic.publisher'); return options.mic === true; },
      receivePublisher: unexpected },
    webTransportMicConnected: () => { note('mic.wt'); return options.wt === true; },
    micTransportGrace: { get pending() { note('mic.grace'); return options.grace === true; } },
    roomHasSong: () => { note('song'); return options.song === true; },
    performance: { now: () => { note(`clock:${now}`); return now; } },
    relayMixPump: { deliver: unexpected },
    decodePcmFrame: (actual: Buffer) => { assert.equal(actual, data); note('decode'); return frame; },
    noteRobotTransitionBackingFrame: (actual: PcmFrame, pcm: Int16Array, start: number, actualNow: number) => {
      assert.equal(actual, frame); assert.equal(pcm, samples); assert.equal(start, -2); assert.equal(actualNow, now); note('transition.frame');
    },
    mappedContentBackingStart: (start: number, actualNow: number) => {
      assert.equal(start, -2); assert.equal(actualNow, now); note('map'); return options.mapped === undefined ? 0 : options.mapped;
    },
    feedContentBackingEvidence: (pcm: Int16Array, start: number, actualNow: number) => {
      assert.equal(pcm, samples); assert.equal(start, options.mapped ?? 0); assert.equal(actualNow, now); note('evidence');
    },
    infrastructureCapability: { authorized: (candidate: Socket) => {
      assert.equal(candidate, socket); note('authorized'); return options.authorized !== false;
    } },
    rejectInfrastructure: (candidate: Socket, message: string) => {
      assert.equal(candidate, socket); assert.equal(message, 'Authenticate Relay infrastructure before registering backing audio.'); note('reject.infrastructure');
    },
    canClaimSocketRole: (candidate: Socket, role: string) => {
      assert.equal(candidate, socket); assert.equal(role, 'backing'); note('role.allowed'); return options.roleAllowed !== false;
    },
    validSampleRate: (value: unknown) => { note('rate.validate'); return value === 48_000 ? 48_000 : null; },
    validCaptureGeneration: (value: unknown) => { note('generation.validate'); return value === 8 ? 8 : null; },
    validSampleCursor: (value: unknown) => { note('cursor.validate'); return value === 0 ? 0 : null; },
    commitSocketRole: (candidate: Socket, role: string) => {
      assert.equal(candidate, socket); assert.equal(role, 'backing'); note('role.commit');
    },
  };
  const workflow = createWorkflow(inputs);
  return { workflow, inputs, state, events, error, socket, other, frame, samples, data,
    registration: actualRegistration(inputs, workflow), uplink: actualUplink(inputs, workflow),
    grace: actualGrace(inputs, workflow) };
}

function activationTrace(previous: 'none' | 'same' | 'other', active: boolean, replaced: boolean,
  robot: boolean, collecting: boolean, rate = 48_000) {
  return ['previous', 'clear', ...(replaced ? ['retire.capture'] : []),
    ...(previous === 'other' ? ['quality:backing-transport-replaced'] : []),
    `retire:${previous === 'none' ? 'none' : previous === 'same' ? 'next' : 'old'}->next`,
    `rate:${rate}`, `bind:${rate}:${robot}`, 'expected:true',
    ...(previous === 'none' ? ['active', ...(active ? ['quality:backing-transport-connected'] : [])] : []),
    'drop', ...(replaced ? ['collecting', ...(collecting ? restartCollecting : restartIdle)] : []),
    'backing.robot', `registered:${robot}`, 'start'];
}

test('actual four Backing configurations and true caller construction are inert', () => {
  const h = fixture(); assert.deepEqual(h.events, []);
  assert.deepEqual(Object.keys(h.workflow), ['activate', 'restartCapture', 'disconnect', 'expireGrace']);
});

for (const previous of ['none', 'same', 'other'] as const) for (const active of [false, true])
for (const replaced of [false, true]) for (const robot of [false, true]) for (const collecting of [false, true]) {
  test(`activation fixed previous/active/replacement/route/collecting matrix ${previous}/${active}/${replaced}/${robot}/${collecting}`, () => {
    const h = fixture({ previous, active, collecting });
    const input = { socket: h.socket, sampleRate: 48_000, robot, captureReplaced: replaced };
    assert.equal(h.workflow.activate(input), undefined);
    assert.deepEqual(h.events, activationTrace(previous, active, replaced, robot, collecting));
    assert.equal(h.socket.sampleRate, 48_000); assert.equal(h.state.bound, h.socket);
    assert.deepEqual(input, { socket: h.socket, sampleRate: 48_000, robot, captureReplaced: replaced });
  });
}

for (const before of [false, true]) for (const after of [false, true]) {
  test(`activation reads collecting live after legacy-drop ${before}/${after}`, () => {
    const h = fixture({ collecting: before, collectingAfterDrop: after });
    h.workflow.activate({ socket: h.socket, sampleRate: 48_000, robot: true, captureReplaced: true });
    assert.deepEqual(h.events, activationTrace('none', true, true, true, after));
  });
}

for (const rate of [0, 44_100]) test(`activation forwards admitted rate without new validation: ${rate}`, () => {
  const h = fixture(); h.workflow.activate({ socket: h.socket, sampleRate: rate, robot: false, captureReplaced: false });
  assert.deepEqual(h.events, activationTrace('none', true, false, false, false, rate));
});

for (const collecting of [false, true]) for (const changed of [false, true]) {
  test(`restart honors passed collecting despite live mutation ${collecting}/${changed}`, () => {
    const h = fixture({ collecting: !collecting, collectingAfterAbandon: changed });
    const input = { calibrationCollecting: collecting };
    assert.equal(h.workflow.restartCapture(input), undefined);
    assert.deepEqual(h.events, collecting ? restartCollecting : restartIdle);
    assert.deepEqual(input, { calibrationCollecting: collecting }); assert.equal(h.state.collecting, changed);
  });
}

for (const collecting of [false, true]) for (const cancel of [false, true]) {
  test(`disconnect live collecting and conditional validation publication ${collecting}/${cancel}`, () => {
    const h = fixture({ collecting, cancel }); assert.equal(h.workflow.disconnect(h.socket), true);
    assert.deepEqual(h.events, ['current', 'quality:backing-transport-disconnected', 'clear', 'detach',
      'expected:false', 'collecting', ...(collecting ? [disconnectFail] : []),
      'cancel', ...(cancel ? ['timing'] : []), 'source', 'status']);
  });
}

test('stale disconnect has only the canonical identity query', () => {
  const h = fixture({ current: false }); assert.equal(h.workflow.disconnect(h.socket), false);
  assert.deepEqual(h.events, ['current']);
});

for (const before of [false, true]) for (const after of [false, true]) {
  test(`disconnect queries collecting after detach effects ${before}/${after}`, () => {
    const h = fixture({ collecting: before, collectingAfterDetach: after }); h.workflow.disconnect(h.socket);
    assert.deepEqual(h.events, ['current', 'quality:backing-transport-disconnected', 'clear', 'detach',
      'expected:false', 'collecting', ...(after ? [disconnectFail] : []), 'cancel', 'source', 'status']);
  });
}

for (const roomHasSong of [false, true]) for (const micArmed of [false, true]) {
  test(`grace preserves outcome and exact consequence ${roomHasSong}/${micArmed}`, () => {
    const h = fixture(), input = { roomHasSong, micArmed };
    assert.equal(h.workflow.expireGrace(input), roomHasSong || !micArmed ? 'stopped' : 'voice-only');
    assert.deepEqual(h.events, roomHasSong || !micArmed ? ['stop'] : voiceOnly);
    assert.deepEqual(input, { roomHasSong, micArmed });
  });
}

for (const control of [false, true]) for (const wt of [false, true])
for (const grace of [false, true]) for (const song of [false, true]) {
  test(`actual grace wrapper preserves Mic-before-Song query short circuits ${control}/${wt}/${grace}/${song}`, () => {
    const h = fixture({ control, wt, grace, song }); assert.equal(h.grace(), undefined);
    assert.deepEqual(h.events, ['mic.control', ...(!control ? ['mic.wt', ...(!wt ? ['mic.grace'] : [])] : []),
      'song', ...(song || !(control || wt || grace) ? ['stop'] : voiceOnly)]);
  });
}

// Every distinct synchronous effect/query failure preserves the thrown object
// and stops all later work. These literal traces do not learn expected output.
for (const scenario of [
  { options: { previous: 'other', collecting: false } as Options, trace: activationTrace('other', true, true, true, false) },
  { options: { collecting: true } as Options, trace: activationTrace('none', true, true, true, true) },
]) for (const [index, event] of scenario.trace.entries()) {
  // 'clear' appears twice; the first throw must stop before the second.
  if (scenario.trace.indexOf(event) !== index) continue;
  test(`activation synchronous cutoff ${scenario.options.previous ?? 'none'}/${event}`, () => {
    const h = fixture({ ...scenario.options, throwAt: event });
    assert.throws(() => h.workflow.activate({ socket: h.socket, sampleRate: 48_000, robot: true, captureReplaced: true }), e => e === h.error);
    assert.deepEqual(h.events, scenario.trace.slice(0, index + 1));
  });
}

for (const collecting of [false, true]) for (const [index, event] of (collecting ? restartCollecting : restartIdle).entries()) {
  test(`restart synchronous cutoff ${collecting}/${event}`, () => {
    const trace = collecting ? restartCollecting : restartIdle, h = fixture({ throwAt: event });
    assert.throws(() => h.workflow.restartCapture({ calibrationCollecting: collecting }), e => e === h.error);
    assert.deepEqual(h.events, trace.slice(0, index + 1));
  });
}

const fullDisconnect = ['current', 'quality:backing-transport-disconnected', 'clear', 'detach',
  'expected:false', 'collecting', disconnectFail, 'cancel', 'timing', 'source', 'status'];
for (const [index, event] of fullDisconnect.entries()) test(`disconnect synchronous cutoff ${event}`, () => {
  const h = fixture({ collecting: true, cancel: true, throwAt: event });
  assert.throws(() => h.workflow.disconnect(h.socket), e => e === h.error);
  assert.deepEqual(h.events, fullDisconnect.slice(0, index + 1));
});

for (const trace of [['stop'], voiceOnly]) for (const [index, event] of trace.entries()) {
  test(`grace synchronous cutoff ${event}`, () => {
    const h = fixture({ throwAt: event });
    assert.throws(() => h.workflow.expireGrace({ roomHasSong: trace[0] === 'stop', micArmed: true }), e => e === h.error);
    assert.deepEqual(h.events, trace.slice(0, index + 1));
  });
}

for (const event of ['mic.control', 'mic.wt', 'mic.grace', 'song']) {
  test(`actual grace query throws before any consequence ${event}`, () => {
    const h = fixture({ throwAt: event }); assert.throws(h.grace, e => e === h.error);
    const prefix = ['mic.control', 'mic.wt', 'mic.grace', 'song'];
    assert.deepEqual(h.events, prefix.slice(0, prefix.indexOf(event) + 1));
  });
}

function uplinkPrefix(empty: boolean, now: number, restarted: boolean, generationChanged: boolean, previous: number | null) {
  return ['mic.publisher', 'current', 'active', 'decode', 'generation', `clock:${now}`,
    'backing.rate', 'backing.robot', `ingest:${now}`, ...(!empty ? [`flow:${now}`] : []),
    ...(!restarted && previous !== null ? ['generation'] : []),
    ...(restarted || previous !== null && generationChanged ? ['collecting', ...restartIdle] : []),
    'transition.frame', 'map'];
}

for (const captureRestarted of [false, true]) for (const generationChanged of [false, true])
for (const empty of [false, true]) for (const now of [0, 73.5]) {
  test(`actual uplink restart detection/accepted-PCM/time ${captureRestarted}/${generationChanged}/${empty}/${now}`, () => {
    const h = fixture({ captureRestarted, generationChanged, empty, now });
    assert.equal(h.uplink.handle(h.socket, h.data), 'backing');
    assert.deepEqual(h.events, [...uplinkPrefix(empty, now, captureRestarted, generationChanged, 7), 'evidence']);
  });
}

for (const collecting of [false, true]) for (const mapped of [null, 0, -7]) {
  test(`actual uplink passed collecting and nullable mapping ${collecting}/${mapped}`, () => {
    const h = fixture({ collecting, mapped, captureRestarted: true }); h.uplink.handle(h.socket, h.data);
    const trace = uplinkPrefix(false, 0, true, false, 7);
    const at = trace.indexOf('collecting');
    assert.deepEqual(h.events, [...trace.slice(0, at + 1), ...(collecting ? restartCollecting : restartIdle),
      'transition.frame', 'map', ...(mapped !== null ? ['evidence'] : [])]);
  });
}

test('null previous generation does not invent a capture replacement', () => {
  const h = fixture({ previousGeneration: null, generationChanged: true }); h.uplink.handle(h.socket, h.data);
  assert.deepEqual(h.events, [...uplinkPrefix(false, 0, false, true, null), 'evidence']);
});

test('stale Backing uplink neither decodes nor samples clock/owner', () => {
  const h = fixture({ current: false }); assert.equal(h.uplink.handle(h.socket, h.data), null);
  assert.deepEqual(h.events, ['mic.publisher', 'current']);
});

test('inactive Backing uplink preserves identity-before-active short circuit', () => {
  const h = fixture({ active: false }); assert.equal(h.uplink.handle(h.socket, h.data), null);
  assert.deepEqual(h.events, ['mic.publisher', 'current', 'active']);
});

const uplinkTrace = [...uplinkPrefix(false, 0, true, false, 7), 'evidence'];
for (const [index, event] of uplinkTrace.entries()) test(`actual uplink synchronous cutoff ${event}`, () => {
  const h = fixture({ captureRestarted: true, throwAt: event });
  assert.throws(() => h.uplink.handle(h.socket, h.data), e => e === h.error);
  assert.deepEqual(h.events, uplinkTrace.slice(0, index + 1));
});

for (const captureReplaced of [false, true]) for (const robot of [false, true, 'true']) {
  test(`actual admitted registration retains identity detection before role/bind ${captureReplaced}/${robot}`, () => {
    const h = fixture({ captureReplaced });
    assert.equal(h.registration(h.socket, { sampleRate: 48_000, captureGeneration: 8, captureSampleCursor: 0, robot }), undefined);
    assert.deepEqual(h.events, ['authorized', 'role.allowed', 'rate.validate', 'generation.validate',
      'cursor.validate', 'replacement.detect', 'role.commit',
      ...activationTrace('none', true, captureReplaced, robot === true, false)]);
  });
}

test('actual legacy registration performs no capture identity detection', () => {
  const h = fixture(); h.registration(h.socket, { sampleRate: 48_000 });
  assert.deepEqual(h.events, ['authorized', 'role.allowed', 'rate.validate', 'role.commit',
    ...activationTrace('none', true, false, false, false)]);
});

test('actual unauthorized registration rejects before role or lifecycle access', () => {
  const h = fixture({ authorized: false }); h.registration(h.socket, { sampleRate: 48_000 });
  assert.deepEqual(h.events, ['authorized', 'reject.infrastructure']);
});

test('actual role-rejected registration has no identity or lifecycle effects', () => {
  const h = fixture({ roleAllowed: false }); h.registration(h.socket, { sampleRate: 48_000 });
  assert.deepEqual(h.events, ['authorized', 'role.allowed']);
});

for (const sampleRate of [undefined, null, '48000', 0, Number.NaN]) {
  test(`actual registration invalid rate rejects before identity/admission: ${String(sampleRate)}`, () => {
    const h = fixture(); h.registration(h.socket, { sampleRate, captureGeneration: 8, captureSampleCursor: 0 });
    assert.deepEqual(h.events, ['authorized', 'role.allowed', 'rate.validate', 'error:Invalid backing sample rate.']);
  });
}

for (const identity of [{ captureGeneration: 8 }, { captureSampleCursor: 0 },
  { captureGeneration: undefined }, { captureSampleCursor: undefined }]) {
  test(`actual registration requires paired own identity fields: ${Object.keys(identity)[0]}/${String(Object.values(identity)[0])}`, () => {
    const h = fixture(); h.registration(h.socket, { sampleRate: 48_000, ...identity });
    assert.deepEqual(h.events, ['authorized', 'role.allowed', 'rate.validate',
      'error:Backing capture identity requires generation and sample cursor together.']);
  });
}

for (const identity of [{ captureGeneration: undefined, captureSampleCursor: 0 },
  { captureGeneration: 8, captureSampleCursor: undefined }, { captureGeneration: '8', captureSampleCursor: 0 },
  { captureGeneration: 8, captureSampleCursor: '0' }, { captureGeneration: null, captureSampleCursor: null }]) {
  test(`actual registration rejects invalid paired identity before replacement detection: ${String(identity.captureGeneration)}/${String(identity.captureSampleCursor)}`, () => {
    const h = fixture(); h.registration(h.socket, { sampleRate: 48_000, ...identity });
    assert.deepEqual(h.events, ['authorized', 'role.allowed', 'rate.validate', 'generation.validate',
      'cursor.validate', 'error:Invalid backing capture identity.']);
  });
}

test('inherited capture identity does not become admitted own identity', () => {
  const h = fixture(), payload: Record<string, unknown> = { sampleRate: 48_000 };
  Object.setPrototypeOf(payload, { captureGeneration: 8, captureSampleCursor: 0 });
  h.registration(h.socket, payload);
  assert.deepEqual(h.events, ['authorized', 'role.allowed', 'rate.validate', 'role.commit',
    ...activationTrace('none', true, false, false, false)]);
});

const registrationPrefix = ['authorized', 'role.allowed', 'rate.validate', 'generation.validate',
  'cursor.validate', 'replacement.detect', 'role.commit'];
for (const [index, event] of registrationPrefix.entries()) {
  test(`actual registration synchronous admission cutoff ${event}`, () => {
    const h = fixture({ throwAt: event });
    assert.throws(() => h.registration(h.socket, { sampleRate: 48_000, captureGeneration: 8, captureSampleCursor: 0 }), e => e === h.error);
    assert.deepEqual(h.events, registrationPrefix.slice(0, index + 1));
  });
}

function actualClose(inputs: object) {
  const startMarker = "socket.on('close', () => {";
  const start = server.text.indexOf(startMarker);
  const end = server.text.indexOf("\n  });\n});\n\nwss.on('close'", start);
  assert.ok(start >= 0 && end > start, 'actual socket close body must exist');
  return new Function(...Object.keys(inputs), `return () => {${server.text.slice(start + startMarker.length, end)}};`)
    (...Object.values(inputs)) as () => void;
}

for (const replaced of [false, true]) for (const micChanged of [false, true]) for (const presenceChanged of [false, true]) {
  test(`actual close preserves Song outside and Robot/Mic/Backing inside replacement fence ${replaced}/${micChanged}/${presenceChanged}`, () => {
    const h = fixture(); h.socket.replaced = replaced; h.socket.participantConnectionId = 'connection';
    const inputs = { ...h.inputs, socket: h.socket,
      relaySongLifecycle: { disconnect: (socket: Socket) => { assert.equal(socket, h.socket); h.events.push('song.disconnect'); } },
      relayRobotMapping: { disconnectSource: (socket: Socket) => { assert.equal(socket, h.socket); h.events.push('robot.disconnect'); } },
      relayMicLifecycle: { disconnect: (socket: Socket) => { assert.equal(socket, h.socket); h.events.push('mic.disconnect'); return micChanged; } },
      relayBackingLifecycle: { disconnect: h.workflow.disconnect },
      Date: { now: () => { h.events.push('wallclock'); return 0; } },
      participants: { detach: (id: string, now: number) => {
        assert.equal(id, 'connection'); assert.equal(now, 0); h.events.push('presence.detach'); return presenceChanged;
      } }, broadcastSessionStatus: () => h.events.push('session.status') };
    assert.equal(actualClose(inputs)(), undefined);
    assert.deepEqual(h.events, ['song.disconnect', ...(!replaced ? ['robot.disconnect', 'mic.disconnect',
      'current', 'quality:backing-transport-disconnected', 'clear', 'detach', 'expected:false',
      'collecting', 'cancel', 'source', 'status'] : []), 'wallclock', 'presence.detach',
      ...(presenceChanged || !replaced && micChanged ? ['session.status'] : [])]);
  });
}

test('canonical BackingRuntime retains Robot route during disconnect grace and retires it only on voice-only consequence', () => {
  const runtime = new BackingRuntime<Socket>({ graceMs: 60_000, isConnected: () => true,
    onGraceExpired: () => { throw new Error('test must cancel its own grace timer'); } });
  const h = fixture({ actualBacking: runtime });
  runtime.bind({ socket: h.socket, sampleRate: 48_000, robot: true });
  try {
    assert.equal(h.workflow.disconnect(h.socket), true);
    assert.equal(runtime.socket, null); assert.equal(runtime.sampleRate, null);
    assert.equal(runtime.gracePending, true); assert.equal(runtime.isRobot, true);
    assert.equal(h.workflow.expireGrace({ roomHasSong: false, micArmed: true }), 'voice-only');
    assert.equal(runtime.isRobot, false);
  } finally { runtime.cancelGrace(); }
});
test('C1 construction reads no owner, command or effect ports', () => {
  const poison = new Proxy({}, { get: () => { throw new Error('constructor must be inert'); } });
  const dependencies = poison as RelayBackingLifecycleDependencies<Socket>;
  const root = createRelayBackingLifecycle(dependencies);
  assert.deepEqual(Object.keys(root), ['activate', 'restartCapture', 'disconnect', 'expireGrace']);
  for (const method of Object.values(root)) assert.equal(typeof method, 'function');
});

test('C1 one Backing boundary reuses all four coordinators without duplicating state, policy, timers or admission', () => {
  const code = readFileSync(new URL('../src/relay-backing-lifecycle.ts', import.meta.url), 'utf8');
  for (const name of ['Activation', 'CaptureRestart', 'Disconnect', 'GraceExpiry']) {
    assert.match(code, new RegExp(`createRelayBacking${name}Coordinator`));
  }
  assert.doesNotMatch(code, /new (?:BackingRuntime|AudioSession|CalibrationSession)|setTimeout|setInterval|Date\.now|performance\.now/);
  assert.doesNotMatch(code, /(?:let|var)\s|captureGeneration|backingCaptureReplacedBy|ingestBacking|decodePcmFrame|infrastructureCapability|canClaimSocketRole|validSampleRate/);
  assert.doesNotMatch(code, /from ['"]\.\/server(?:-entry)?\.js['"]|\bany\b|Object\.assign|\.\.\.dependencies/);
});

test('C2 actual root binds canonical owners and command references without early reads or effects', () => {
  const h = fixture(); let bound: RelayBackingLifecycleDependencies<Socket> | null = null;
  const root = createWorkflow(h.inputs, dependencies => {
    bound = dependencies; return createRelayBackingLifecycle(dependencies);
  });
  assert.deepEqual(h.events, []); assert.ok(bound);
  const dependencies = bound as RelayBackingLifecycleDependencies<Socket>;
  assert.equal(dependencies.backing, h.inputs.backingRuntime); assert.equal(dependencies.mix, h.inputs.session);
  assert.equal(dependencies.calibration, h.inputs.calibration); assert.equal(dependencies.take, h.inputs.takeController);
  for (const key of ['clearRobotContentTransition', 'dropLegacyCalibrationForRobot', 'abandonProbeRun',
    'clearContentValidationBaseline', 'cancelActiveContentValidation', 'syncAppliedCalibration',
    'invalidateMicTiming', 'startLiveSource', 'stopLiveSource'] as const) {
    assert.equal(dependencies.commands[key], h.inputs[key]);
  }
  assert.equal(dependencies.effects.retirePrevious, h.inputs.replacePrevious);
  assert.deepEqual(Object.keys(root), ['activate', 'restartCapture', 'disconnect', 'expireGrace']);
});

test('C2 one actual root serves all real callers and preserves owner, startup and shutdown order', () => {
  const code = server.text;
  for (const name of ['Activation', 'CaptureRestart', 'Disconnect', 'GraceExpiry']) {
    assert.equal(code.includes(`createRelayBacking${name}Coordinator`), false);
  }
  for (const name of ['backingActivationCoordinator', 'backingCaptureRestartCoordinator',
    'backingDisconnectCoordinator', 'backingGraceExpiryCoordinator']) assert.equal(code.includes(name), false);
  assert.equal((code.match(/const relayBackingLifecycle =/g) ?? []).length, 1);
  assert.match(objectArrowCallbackCode(server, 'registrationProtocol', 'backing'), /relayBackingLifecycle\.activate\(/);
  const restart = objectArrowCallbackCode(server, 'audioUplinkCoordinator', 'onBackingCaptureRestarted');
  assert.match(restart, /relayBackingLifecycle\.restartCapture\(\{\s*calibrationCollecting: calibration\.collecting/);
  assert.doesNotMatch(restart, /performance\.now|Date\.now|takeController\.|calibration\.fail/);
  assert.match(functionCode(server, 'expireBackingGrace'), /relayBackingLifecycle\.expireGrace\(/);
  assert.match(variableInitializerCode(server, 'backingRuntime'), /onGraceExpired:\s*expireBackingGrace/);
  const drop = functionCode(server, 'dropLegacyCalibrationForRobot');
  assert.match(drop, /relayRobotMapping\.dropLegacyCalibration\(\)/);
  let previous = -1;
  for (const marker of ['const calibration =', 'const backingRuntime =', 'const micRuntime =',
    'const relayRobotMapping =', 'const relayBackingLifecycle =', 'const relayMixPump =',
    'relayMixPump.start();', 'const youtubeTimelineTimer =', "wss.on('close'",
    'monitorTransport.enableOpus(await loadMonitorOpusEncoder(', 'await webTransportMedia.start(',
    "server.listen(port, '0.0.0.0'", 'async function gracefulShutdown(']) {
    const at = code.indexOf(marker); assert.ok(at > previous, `missing/reordered ${marker}`); previous = at;
  }
});
