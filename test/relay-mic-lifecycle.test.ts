import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import WebSocket from 'ws';

import { AudioSession } from '../src/audio-session.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { BootProbeRuntime } from '../src/boot-probe-runtime.js';
import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import { MicRuntime } from '../src/mic-runtime.js';
import { MicTransportGraceRuntime } from '../src/mic-transport-grace-runtime.js';
import { ParticipantSession } from '../src/participant-session.js';
import { createRelayCalibrationOrchestration } from '../src/relay-calibration-orchestration.js';
import { createRelayMicLifecycle, type RelayMicLifecycleDependencies } from '../src/relay-mic-lifecycle.js';
import { createRelayMicTimingInvalidationCoordinator } from '../src/relay-mic-timing-invalidation-coordinator.js';
import type { RelaySocket } from '../src/relay-socket-server.js';
import { RobotContentTimelineMapper } from '../src/robot-content-timeline.js';
import { TakeSession } from '../src/take-session.js';
import { TakeQualityTracker, type TakeQualityEventKind } from '../src/take-quality.js';
import { TimingRuntime } from '../src/timing-runtime.js';
import { applyMicOwnerTransitionEffects } from '../src/mic-owner-transition-application.js';
import { micOwnerTransitionEffects, type MicOwnerTransitionEffects } from '../src/mic-owner-transition.js';
import type { PublisherActivationRequest } from '../src/relay-publisher-activation-coordinator.js';
import type { RelayMicReleaseInput } from '../src/relay-mic-release-coordinator.js';
import { functionCode, hasFunction, importSources, objectArrowCallbackCode,
  parseTypeScriptSource, sourceCode, variableInitializerCode } from './support/source-contract.js';

type Socket = { id?: string; participantId?: string };
type Workflow<TSocket extends Socket = Socket> = {
  activate(input: PublisherActivationRequest<TSocket, MicOwnerTransitionEffects>): void;
  release(input: RelayMicReleaseInput<TSocket, MicOwnerTransitionEffects>): void;
  disconnect(socket: TSocket): boolean;
  expire(ownerId: string): void;
  clearMediaAuthority(): void;
};

type LegacyPorts<TSocket extends Socket> = {
  performance: RelayMicLifecycleDependencies<TSocket>['clock'];
  participants: RelayMicLifecycleDependencies<TSocket>['participants'];
  micRuntime: Omit<RelayMicLifecycleDependencies<TSocket>['mic'], 'directMediaConnected' | 'streaming'>;
  session: RelayMicLifecycleDependencies<TSocket>['mix'];
  micTransportGrace: RelayMicLifecycleDependencies<TSocket>['grace'];
  backingRuntime: RelayMicLifecycleDependencies<TSocket>['backing'];
  calibration: RelayMicLifecycleDependencies<TSocket>['calibration'];
  takeController: RelayMicLifecycleDependencies<TSocket>['take'] & { statusPayload(): { type: string } };
  applyMicOwnerEffects: RelayMicLifecycleDependencies<TSocket>['commands']['applyOwnershipEffects'];
  participantPayload: RelayMicLifecycleDependencies<TSocket>['queries']['participantPayload'];
  retireSocket: RelayMicLifecycleDependencies<TSocket>['effects']['retirePublisher'];
  clearRobotContentTransition(): void; invalidateMicTiming(reason: string): void;
  resetMicAudibility(): void; micLevel: { reset(): void };
  webTransportMicConnected(): boolean; micStreaming(nowMs: number): boolean;
  refreshLiveMicNetworkCompensation(): void; stopLiveSource(): void;
  cancelActiveContentValidation(): boolean; beginPreparedSongHandoff(id: string): void;
  broadcastStatus(): void; broadcastSessionStatus(): void;
  broadcastJson(payload: { type: string }): void;
  sendJson(socket: TSocket, payload: { type: string; [key: string]: unknown }): void;
  mixSettingsPayload(): { type: string };
  youtubeTimeline: { statusPayload(): { type: string }; roomStatusPayload(): { type: string } };
  roomSongCommandStatusPayload(): { type: string };
  sourceStatusPayload(): { type: string }; timingCalibrationStatusPayload(): { type: string };
};

// C0's actual server adapter is in S30-C0-frozen-source.tar. Only this entry
// changes for C1. Every literal trace, state assertion and real-owner matrix
// below remains unchanged; schema adapters are the same original server I/O.
function unexpectedRestartEffect(): never {
  throw new Error('existing Mic lifecycle cases must not restart capture evidence');
}

function workflowFromPorts<TSocket extends Socket>(d: LegacyPorts<TSocket>): Workflow<TSocket> {
  return createRelayMicLifecycle({ clock: d.performance, participants: d.participants,
    mic: {
      get publisher() { return d.micRuntime.publisher; },
      get mediaOwnerId() { return d.micRuntime.mediaOwnerId; },
      get audioTransport() { return d.micRuntime.audioTransport; },
      get mediaTicket() { return d.micRuntime.mediaTicket; },
      isPublisher: socket => d.micRuntime.isPublisher(socket),
      controlConnected: () => d.micRuntime.controlConnected(),
      directMediaConnected: d.webTransportMicConnected, streaming: d.micStreaming,
      bindPublisher: registration => d.micRuntime.bindPublisher(registration),
      detachPublisher: socket => d.micRuntime.detachPublisher(socket),
      clearMediaAuthority: nowMs => d.micRuntime.clearMediaAuthority(nowMs),
      directMediaOffer: () => d.micRuntime.directMediaOffer(),
    }, mix: d.session, grace: d.micTransportGrace, backing: d.backingRuntime,
    calibration: d.calibration, take: d.takeController,
    queries: { participantPayload: d.participantPayload },
    commands: { applyOwnershipEffects: d.applyMicOwnerEffects, invalidateTiming: d.invalidateMicTiming,
      clearRobotContentTransition: d.clearRobotContentTransition,
      refreshLiveMicNetworkCompensation: d.refreshLiveMicNetworkCompensation,
      cancelActiveContentValidation: d.cancelActiveContentValidation, stopLiveSource: d.stopLiveSource,
      beginPreparedSongHandoff: d.beginPreparedSongHandoff,
      abandonProbeRun: unexpectedRestartEffect, clearContentValidationBaseline: unexpectedRestartEffect,
      syncAppliedCalibration: unexpectedRestartEffect },
    effects: { resetMicAudibility: d.resetMicAudibility, resetMicLevel: () => d.micLevel.reset(),
      retirePublisher: d.retireSocket,
      sendRegistered: (socket, result) => d.sendJson(socket, { type: 'registered', role: 'publisher',
        takeover: result.takeover, ...(result.mediaTransport ? { mediaTransport: result.mediaTransport } : {}) }),
      sendInitialState: socket => {
        d.sendJson(socket, d.mixSettingsPayload()); d.sendJson(socket, d.youtubeTimeline.statusPayload());
        d.sendJson(socket, d.youtubeTimeline.roomStatusPayload()); d.sendJson(socket, d.roomSongCommandStatusPayload());
        d.sendJson(socket, d.takeController.statusPayload()); d.sendJson(socket, d.sourceStatusPayload());
        d.sendJson(socket, d.timingCalibrationStatusPayload());
      },
      sendReleased: socket => d.sendJson(socket, { type: 'mic-released' }),
      reportStatus: d.broadcastStatus, reportSessionStatus: d.broadcastSessionStatus,
      reportTimingStatus: () => d.broadcastJson(d.timingCalibrationStatusPayload()),
      reportSourceStatus: () => d.broadcastJson(d.sourceStatusPayload()) },
  });
}

function fixture(options: {
  active?: boolean; collecting?: boolean; direct?: boolean; flowing?: boolean;
  control?: boolean; backingConnected?: boolean; backingArmed?: boolean;
  captureReplaced?: boolean; sameParticipantReplacement?: boolean;
  validationChanged?: boolean; releaseOk?: boolean; throwAt?: string;
} = {}) {
  const events: string[] = [], sent: Array<{ socket: Socket; payload: unknown }> = [];
  const old: Socket = { id: 'old', participantId: 'participant-alice' };
  const next: Socket = { id: 'next', participantId: 'participant-bob' };
  const state = { owner: 'participant-alice' as string | null, publisher: old as Socket | null,
    mediaOwner: 'participant-alice' as string | null, ticket: {} as object | null,
    transport: {} as object | null, expected: true, grace: true, active: options.active ?? true,
    control: options.control ?? true, direct: options.direct ?? false,
    flowing: options.flowing ?? true, collecting: options.collecting ?? false };
  const error = new Error('original port error');
  function note(event: string) { events.push(event); if (event === options.throwAt) throw error; }
  const effects = micOwnerTransitionEffects({ previousOwnerId: 'participant-alice',
    ownerId: 'participant-bob', cause: 'publisher-registration' });
  const clock = { now() { note('clock'); return 42; } };
  const invalidateTiming = (reason: string) => { note(`timing.invalidate:${reason}`); };
  const beginHandoff = (id: string) => { note(`song.handoff:${id}`); };
  const inputs = {
    performance: clock,
    participants: {
      get micOwnerId() { return state.owner; },
      releaseMic(ownerId: string, cause: 'transport-expired') {
        note(`lease.release:${ownerId}:${cause}`);
        const ok = options.releaseOk !== false;
        const previousOwnerId = state.owner;
        if (ok) state.owner = null;
        return { ok, effects: micOwnerTransitionEffects({ previousOwnerId, ownerId: null, cause }) };
      },
    },
    micRuntime: {
      get publisher() { return state.publisher; }, get mediaOwnerId() { return state.mediaOwner; },
      get audioTransport() { return state.transport; }, get mediaTicket() { return state.ticket; },
      isPublisher(socket: Socket) { note('is-publisher'); return socket === state.publisher; },
      controlConnected() { note('control'); return state.control; },
      bindPublisher(registration: { socket: Socket; sampleRate: number; captureGeneration: number | null;
        initialSequence?: number; audioPacketVersion: 1 | 2; nowMs: number }) {
        assert.equal(registration.nowMs, 42); assert.equal(registration.sampleRate, 48_000);
        assert.equal(registration.captureGeneration, 7); assert.equal(registration.initialSequence, 11);
        assert.equal(registration.audioPacketVersion, 2);
        note('bind'); const previousPublisher = state.publisher;
        state.publisher = registration.socket; state.mediaOwner = registration.socket.participantId ?? null;
        return { previousPublisher, sameParticipantReplacement: options.sameParticipantReplacement === true,
          sameCapture: options.captureReplaced !== true, captureReplaced: options.captureReplaced === true };
      },
      detachPublisher(socket: Socket) { assert.equal(socket, state.publisher); note('detach'); state.publisher = null; state.control = false; },
      clearMediaAuthority(nowMs: number) { assert.equal(nowMs, 42); note('media.clear');
        state.mediaOwner = null; state.ticket = null; state.transport = null; },
      directMediaOffer() { note('direct.offer'); return { ticket: 'offer' }; },
    },
    session: {
      get active() { note('mix.active'); return state.active; },
      setMicExpected(value: boolean) { note(`mix.expected:${value}`); state.expected = value; },
      retireMicCapture() { note('mix.retire-capture'); },
    },
    micTransportGrace: {
      get pending() { note('grace.pending'); return state.grace; },
      schedule(ownerId: string) { note(`grace.schedule:${ownerId}`); state.grace = true; },
      cancel() { note('grace.cancel'); state.grace = false; },
    },
    backingRuntime: {
      connected() { note('backing.connected'); return options.backingConnected !== false; },
      armed() { note('backing.armed'); return options.backingArmed !== false; },
    },
    calibration: {
      get collecting() { note('cal.collecting'); return state.collecting; },
      fail(message: string) { note(`cal.fail:${message}`); state.collecting = false; },
    },
    takeController: { noteQualityEvent(event: string) { note(`take:${event}`); } },
    applyMicOwnerEffects(current: MicOwnerTransitionEffects, nowMs = clock.now(),
      hooks: { afterQualityEvent?: () => void; beforeTimingInvalidation?: () => void;
        invalidateTiming?: (reason: string) => void; prepareSongHandoff?: (id: string) => void } = {}) {
      assert.equal(nowMs, 42); note('ownership.apply');
      return applyMicOwnerTransitionEffects(current, {
        noteQualityEvent(event) { note(`take:${event}`); hooks.afterQualityEvent?.(); },
        cancelRoomSongCommand(reason) { note(`room.cancel:${reason}`); },
        cancelSongHandoff() { note('song.cancel'); return true; },
        publishSongHandoffCancellation() { note('song.cancel-publish'); },
        invalidateTiming(reason) { hooks.beforeTimingInvalidation?.();
          if (hooks.invalidateTiming) hooks.invalidateTiming(reason); else invalidateTiming(reason); },
        restoreMicGain(id) { note(`gain.restore:${id}`); },
        prepareSongHandoff(id) { if (hooks.prepareSongHandoff) hooks.prepareSongHandoff(id);
          else beginHandoff(id); },
      });
    },
    participantPayload(id: string) { note(`participant:${id}`); return { nickname: 'Bob' }; },
    retireSocket(socket: Socket, payload: { type: string; message: string }) { note(`retire:${socket.id}:${payload.type}`); sent.push({ socket, payload }); },
    clearRobotContentTransition() { note('transition.clear'); },
    invalidateMicTiming: invalidateTiming,
    resetMicAudibility() { note('audibility.reset'); }, micLevel: { reset() { note('level.reset'); } },
    webTransportMicConnected() { note('direct.connected'); return state.direct; },
    micStreaming(nowMs: number) { assert.equal(nowMs, 42); note('pcm.fresh'); return state.flowing; },
    refreshLiveMicNetworkCompensation() { note('network.refresh'); },
    stopLiveSource() { note('source.stop'); state.active = false; },
    cancelActiveContentValidation() { note('validation.cancel'); return options.validationChanged === true; },
    beginPreparedSongHandoff: beginHandoff,
    broadcastStatus() { note('status'); }, broadcastSessionStatus() { note('session.status'); },
    broadcastJson(payload: { type: string }) { note(`publish:${payload.type}`); },
    sendJson(socket: Socket, payload: { type: string }) { note(`send:${payload.type}`); sent.push({ socket, payload }); },
    mixSettingsPayload: () => ({ type: 'mix-settings' }),
    youtubeTimeline: { statusPayload: () => ({ type: 'youtube-timeline' }), roomStatusPayload: () => ({ type: 'room-song-status' }) },
    roomSongCommandStatusPayload: () => ({ type: 'room-song-command-status' }),
    sourceStatusPayload: () => ({ type: 'source-status' }),
    timingCalibrationStatusPayload: () => ({ type: 'timing-calibration-status' }),
  };
  const controllerInputs = { ...inputs, takeController: { ...inputs.takeController,
    statusPayload: () => ({ type: 'take-status' }) } };
  return { workflow: workflowFromPorts(controllerInputs), inputs: controllerInputs,
    events, sent, old, next, effects, state, error };
}
type Fixture = ReturnType<typeof fixture>;
function activation(h: Fixture, ownershipEffects: MicOwnerTransitionEffects | null = null) {
  return { socket: h.next, ownershipEffects, previousOwnerId: 'participant-alice', takeoverRequested: true,
    sampleRate: 48_000, captureGeneration: 7, initialSequence: 11, audioPacketVersion: 2 as const };
}
const clearTrace = ['clock', 'media.clear', 'mix.expected:false', 'audibility.reset', 'level.reset'];
const initialTrace = ['send:mix-settings', 'send:youtube-timeline', 'send:room-song-status',
  'send:room-song-command-status', 'send:take-status', 'send:source-status', 'send:timing-calibration-status'];
const restartTrace = ['mix.active', 'backing.connected', 'network.refresh', 'cal.collecting', 'validation.cancel', 'publish:source-status'];

test('old Mic lifecycle construction performs no reads or effects', () => {
  const h = fixture(); assert.deepEqual(h.events, []); assert.equal(h.sent.length, 0);
});

test('old admitted cross-owner activation defers timing and handoff until bind and ordered publications', () => {
  const h = fixture({ captureReplaced: true }); h.state.owner = 'participant-bob';
  assert.equal(h.workflow.activate(activation(h, h.effects)), undefined);
  assert.deepEqual(h.events, ['clock', 'ownership.apply', 'take:mic-owner-changed', 'room.cancel:mic-owner-changed',
    'gain.restore:participant-bob', 'clock', 'bind', 'transition.clear', 'mix.retire-capture', 'take:mic-capture-restarted',
    'participant:participant-bob', 'retire:old:mic-revoked', 'grace.cancel', 'mix.expected:true',
    'timing.invalidate:Microphone ownership changed.', ...restartTrace, 'direct.offer', 'send:registered',
    ...initialTrace, 'status', 'session.status', 'song.handoff:participant-bob']);
  assert.deepEqual(h.sent[0].payload, { type: 'mic-revoked', message: 'Bob took over the microphone.' });
  assert.deepEqual(h.sent[1].payload, { type: 'registered', role: 'publisher', takeover: true, mediaTransport: { ticket: 'offer' } });
});

for (const replaced of [false, true]) test(`old same-participant activation captureReplaced=${replaced}`, () => {
  const h = fixture({ captureReplaced: replaced, sameParticipantReplacement: true });
  h.next.participantId = 'participant-alice';
  h.workflow.activate({ ...activation(h), takeoverRequested: false });
  assert.deepEqual(h.events, ['clock', 'bind', ...(replaced ? ['transition.clear', 'mix.retire-capture', 'take:mic-capture-restarted'] : []),
    'participant:participant-alice', 'retire:old:publisher-superseded', 'grace.cancel', 'mix.expected:true',
    ...(replaced ? ['timing.invalidate:Microphone capture changed.'] : []), ...restartTrace,
    'direct.offer', 'send:registered', ...initialTrace, 'status', 'session.status']);
  assert.equal(h.state.publisher, h.next); assert.equal(h.state.grace, false);
});

test('old anonymous first activation preserves transport quality and omits participant handoff', () => {
  const h = fixture(); h.state.publisher = null; delete h.next.participantId;
  h.workflow.activate(activation(h));
  assert.deepEqual(h.events, ['clock', 'bind', 'grace.cancel', 'mix.expected:true', 'mix.active',
    'take:mic-transport-connected', ...restartTrace, 'direct.offer', 'send:registered', ...initialTrace, 'status']);
});

for (const active of [false, true]) test(`old reconnect restart active=${active} cannot invent source activity`, () => {
  const h = fixture({ active, backingConnected: false }); h.workflow.activate(activation(h));
  assert.equal(h.events.includes('network.refresh'), false);
  assert.equal(h.events.includes('backing.connected'), active);
  assert.equal(h.events.includes('validation.cancel'), false);
});

test('old collecting reconnect fails then conditionally publishes canceled validation before source', () => {
  const h = fixture({ collecting: true, validationChanged: true }); h.workflow.activate(activation(h));
  const start = h.events.indexOf('network.refresh');
  assert.deepEqual(h.events.slice(start, h.events.indexOf('direct.offer')), ['network.refresh', 'cal.collecting',
    'cal.fail:Microphone reconnected during calibration. Start calibration again.', 'validation.cancel',
    'publish:timing-calibration-status', 'publish:source-status']);
});

for (const mode of ['publisher', 'media-only', 'neither'] as const) test(`old explicit release ${mode} cleans once before timing and acknowledges last`, () => {
  const h = fixture();
  if (mode !== 'publisher') h.state.publisher = h.next;
  if (mode === 'neither') h.state.mediaOwner = 'participant-bob';
  const effects = micOwnerTransitionEffects({ previousOwnerId: 'participant-alice', ownerId: null, cause: 'explicit-release' });
  assert.equal(h.workflow.release({ socket: h.old, participantId: 'participant-alice', effects }), undefined);
  const cleanup = mode === 'publisher' ? ['detach', ...clearTrace, 'retire:old:mic-revoked', 'status']
    : mode === 'media-only' ? clearTrace : [];
  assert.deepEqual(h.events, ['clock', 'ownership.apply', 'take:mic-owner-changed', 'grace.cancel',
    'room.cancel:mic-owner-released', 'song.cancel', 'song.cancel-publish', ...cleanup,
    'timing.invalidate:Microphone was released.', 'session.status', 'send:mic-released']);
  assert.equal(h.events.filter(e => e === 'media.clear').length, mode === 'neither' ? 0 : 1);
});

test('old stale/noncurrent disconnect has no effects beyond authority query', () => {
  const h = fixture(); assert.equal(h.workflow.disconnect(h.next), false);
  assert.deepEqual(h.events, ['is-publisher']); assert.equal(h.state.publisher, h.old);
});

for (const direct of [false, true]) test(`old reconnectable control disconnect directConnected=${direct} preserves capture and grace`, () => {
  const h = fixture({ direct, collecting: true, validationChanged: true });
  const ticket = h.state.ticket, transport = h.state.transport;
  assert.equal(h.workflow.disconnect(h.old), true);
  assert.deepEqual(h.events, ['is-publisher', 'take:mic-transport-disconnected', 'detach', 'direct.connected',
    `mix.expected:${direct}`, 'grace.schedule:participant-alice', 'cal.collecting',
    'cal.fail:Microphone disconnected during calibration.', 'validation.cancel', 'publish:timing-calibration-status', 'status']);
  assert.equal(h.state.ticket, ticket); assert.equal(h.state.transport, transport);
  assert.equal(h.state.publisher, null); assert.equal(h.state.owner, 'participant-alice');
});

for (const backingArmed of [false, true]) test(`old nonreconnectable disconnect backingArmed=${backingArmed} clears then checks unarmed source`, () => {
  const h = fixture({ backingArmed }); h.state.owner = null; h.state.grace = false;
  assert.equal(h.workflow.disconnect(h.old), true);
  assert.deepEqual(h.events, ['is-publisher', 'take:mic-transport-disconnected', 'detach', ...clearTrace,
    'mix.active', 'control', 'direct.connected', 'grace.pending', 'backing.armed',
    ...(!backingArmed ? ['source.stop'] : []), 'cal.collecting', 'validation.cancel', 'status']);
  assert.equal(h.state.transport, null); assert.equal(h.state.active, backingArmed);
});

test('old expiry ignores a changed lease without sampling transport or clock', () => {
  const h = fixture(); h.workflow.expire('participant-bob'); assert.deepEqual(h.events, []);
});
test('old expiry ignores reconnected same-owner control before sampling direct PCM', () => {
  const h = fixture(); h.workflow.expire('participant-alice'); assert.deepEqual(h.events, ['control']);
});
test('old expiry retains same-owner direct media only with fresh accepted PCM', () => {
  const h = fixture({ control: false, direct: true }); h.state.publisher = null;
  h.workflow.expire('participant-alice');
  assert.deepEqual(h.events, ['control', 'direct.connected', 'clock', 'pcm.fresh', 'grace.schedule:participant-alice']);
  assert.equal(h.state.owner, 'participant-alice'); assert.notEqual(h.state.transport, null);
});
for (const direct of [false, true]) test(`old expiry without fresh direct PCM direct=${direct} releases then clears and applies default-clock effects`, () => {
  const h = fixture({ control: false, direct, flowing: false }); h.state.publisher = null;
  assert.equal(h.workflow.expire('participant-alice'), undefined);
  assert.deepEqual(h.events, ['control', 'direct.connected', ...(direct ? ['clock', 'pcm.fresh'] : []),
    'lease.release:participant-alice:transport-expired', ...clearTrace, 'clock', 'ownership.apply',
    'take:mic-owner-changed', 'room.cancel:mic-owner-released',
    'timing.invalidate:Microphone transport did not reconnect before its grace period expired.', 'session.status']);
  assert.equal(h.state.owner, null); assert.equal(h.state.transport, null); assert.equal(h.state.expected, false);
  assert.equal(h.events.includes('song.cancel'), false);
});
test('old rejected expiry release leaves media and meter state untouched', () => {
  const h = fixture({ control: false, releaseOk: false });
  h.workflow.expire('participant-alice');
  assert.deepEqual(h.events, ['control', 'direct.connected', 'lease.release:participant-alice:transport-expired']);
  assert.notEqual(h.state.transport, null); assert.equal(h.state.expected, true);
});
test('old media clear is repeatable and samples its own clock on every call', () => {
  const h = fixture(); h.workflow.clearMediaAuthority(); h.workflow.clearMediaAuthority();
  assert.deepEqual(h.events, [...clearTrace, ...clearTrace]); assert.equal(h.state.transport, null);
});

for (const throwAt of ['bind', 'mix.retire-capture', 'send:registered']) test(`old activation preserves original exception and stops at ${throwAt}`, () => {
  const h = fixture({ captureReplaced: true, throwAt });
  assert.throws(() => h.workflow.activate(activation(h)), e => e === h.error);
  assert.equal(h.events.at(-1), throwAt); assert.equal(h.events.includes('session.status'), false);
});

// The matrix uses real lease, transport, mixer, timing, grace, Take lifecycle
// and quality owners. Only physical socket I/O and Song/publication ports are
// replaced. Real server→WAV coverage remains in the existing S-MEDIA profile.
function realFixture(options: { graceMs?: number } = {}) {
  const base = fixture();
  const control = { now: 42, direct: false };
  const participants = new ParticipantSession(5_000);
  for (const [id, nickname] of [['participant-alice', 'Alice'], ['participant-bob', 'Bob']]) {
    participants.attach({ connectionId: id, participantId: id, nickname, nowMs: 1_000 });
  }
  assert.equal(participants.acquireMic('participant-alice').ok, true);
  function socket(id: string, participantId: string): RelaySocket & Socket {
    return { id, participantId, role: 'publisher', isAlive: true, readyState: WebSocket.OPEN } as RelaySocket & Socket;
  }
  const old = socket('old', 'participant-alice');
  let tickets = 0;
  const mic = new MicRuntime({ audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000, streamLiveMs: 1_000,
    createDirectMediaTicket: () => `matrix-ticket-${++tickets}`,
    directMediaConnected: () => control.direct, offerDirectMedia: ticket => ({ ticket }) });
  const mix = new AudioSession({ sampleRate: 48_000, frameMs: 20, prebufferMs: 40,
    retentionMs: 2_000, backingGain: 1 });
  mix.start(control.now); mix.setMicExpected(true);
  mic.bindPublisher({ socket: old, sampleRate: 48_000, captureGeneration: 7,
    audioPacketVersion: 2, initialSequence: 0, nowMs: control.now });
  const pcm = Buffer.alloc(960 * 2, 8);
  const packet = encodeAudioPacket({ source: 'mic', generation: 7, sequence: 0,
    firstSampleIndex: 0, pcm });
  const frames = mic.receivePublisher(old, packet, control.now);
  assert.equal(frames.length, 1);
  for (const frame of frames) {
    assert.ok(mix.ingestMic(frame, 48_000, control.now).samples.length > 0);
    mic.noteFrame(control.now, frame);
  }
  const health: AudioUplinkHealth = { version: 1, captureGeneration: 7, capturedSamples: 960,
    inputMuted: false, inputGapActive: false, inputGapSamples: 0, capture: null, captureLevel: null,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 }, controlReconnects: 0,
    transport: { path: 'websocket', maxPacketBytes: null, minWebTransportMaxPacketBytes: null,
      maxWebTransportMaxPacketBytes: null, datagramPacketBytesCeiling: null, datagramQueuePackets: null,
      webTransportAttempts: 0, webTransportConnections: 0, webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0, webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0, webTransportSendFailures: 0,
      webSocketPacketsSent: 0, webSocketCongestedRejects: 0, webSocketDisconnectedRejects: 0, webSocketSendFailures: 0 } };
  assert.equal(mic.noteUplinkHealth(old, health, control.now), true);
  assert.equal(mic.streaming(control.now), true);
  const timing = new TimingRuntime({ autoCalibrationRetryMs: 1_000 });
  const context = (): CalibrationContext => ({ sessionGeneration: mix.generation,
    micGeneration: mix.micGeneration, backingGeneration: mix.backingGeneration,
    micSourceRate: mic.sampleRate, backingSourceRate: 48_000, sourceGeneration: 0 });
  const calibration: CalibrationSession = new CalibrationSession({ sampleRate: 48_000,
    durationMs: 20, timeoutMs: 1_000, context, now: () => control.now,
    onSettled: () => timing.syncConfirmedAuthority({ confirmedRevision: calibration.confirmedRevision,
      hasConfirmedResult: calibration.confirmedResult !== null }) });
  const take = new TakeSession(), quality = new TakeQualityTracker({ sampleRate: 48_000 });
  const probe = new BootProbeRuntime({ maxAttempts: 1, retryMs: 1_000 });
  const applier = createRelayCalibrationOrchestration({ config: { reapplyThresholdMs: 20 },
    clock: { now: () => control.now }, mix, mic, calibration, timing, probe,
    backing: { sampleRate: 48_000 }, source: { generation: 0, connected: () => false },
    contentTimeline: new RobotContentTimelineMapper({ sampleRate: 48_000, freshForMs: 10_000 }),
    queries: { takeBlocksCalibration: () => take.lifecycle === 'recording',
      robotRouteActive: () => false, robotProbeTimingActive: () => false,
      bootProbeSettled: () => false, bootProbeContext: context, roomHasSong: () => false,
      robotDeltaIsFresh: () => false, robotDeltaEverEstablished: () => false,
      robotContentMappingReady: () => false, currentDeltaMs: () => 0, currentPlaybackRate: () => 1 } });
  timing.markContentAuthority();
  calibration.applyValidatedResult({ micLagMs: 250, confidence: 0.9, segmentLagsMs: [250],
    segmentCorrelations: [0.9], micLevelDbfs: -20, backingLevelDbfs: -20 });
  applier.syncApplied();
  assert.equal(mix.alignment.calibratedMicLagMs, 250);
  assert.equal(take.start({ takeId: 'matrix-take', startedByParticipantId: 'participant-alice',
    song: { videoId: null, revision: null, state: null, serverTime: null, playbackRate: null },
    startPosition: { generation: mix.generation, firstSampleIndex: 0 }, startedAtMs: 1_000 }).ok, true);
  const invalidation = createRelayMicTimingInvalidationCoordinator({
    clearBootCalibration: () => probe.clear(), clearContentValidation: () => timing.clearContentValidationBaseline(),
    invalidateCalibration: reason => { if (calibration.collecting) calibration.fail(reason); else calibration.reset(); },
    clearTimingKind: () => timing.clearCalibrationKind(),
    resetAutoCalibrationSchedule: () => timing.resetAutoCalibrationSchedule(),
    syncAppliedCalibration: () => { applier.syncApplied(); },
    reportTimingStatus: () => {}, reportSourceStatus: () => {},
  });
  const invalidationReasons: string[] = [];
  let expireResolve!: (ownerId: string) => void;
  const expired = new Promise<string>(resolve => { expireResolve = resolve; });
  const grace = new MicTransportGraceRuntime({ graceMs: options.graceMs ?? 10_000,
    onExpired: ownerId => { workflow.expire(ownerId); expireResolve(ownerId); } });
  function applyEffects(effects: MicOwnerTransitionEffects, _nowMs = control.now,
    hooks: { afterQualityEvent?: () => void; beforeTimingInvalidation?: () => void;
      invalidateTiming?: (reason: string) => void; prepareSongHandoff?: (id: string) => void } = {}) {
    return applyMicOwnerTransitionEffects(effects, {
      noteQualityEvent(event) { quality.noteEvent(event); hooks.afterQualityEvent?.(); },
      cancelRoomSongCommand: () => {}, cancelSongHandoff: () => false,
      publishSongHandoffCancellation: () => {},
      invalidateTiming(reason) { hooks.beforeTimingInvalidation?.();
        if (hooks.invalidateTiming) hooks.invalidateTiming(reason); else invalidate(reason); },
      restoreMicGain: () => {}, prepareSongHandoff(id) { hooks.prepareSongHandoff?.(id); },
    });
  }
  function invalidate(reason: string) { invalidationReasons.push(reason); invalidation.invalidate(reason); }
  const inputs = { ...base.inputs, performance: { now: () => control.now }, participants,
    micRuntime: mic, session: mix, micTransportGrace: grace, calibration,
    takeController: { noteQualityEvent: (event: TakeQualityEventKind) => quality.noteEvent(event),
      statusPayload: () => take.statusPayload() },
    applyMicOwnerEffects: applyEffects, invalidateMicTiming: invalidate,
    participantPayload: (id: string) => participants.participant(id),
    retireSocket: (socket: RelaySocket) => { socket.replaced = true; },
    webTransportMicConnected: () => mic.directMediaConnected(), micStreaming: (nowMs: number) => mic.streaming(nowMs),
    stopLiveSource: () => mix.stop(),
  };
  const workflow = workflowFromPorts(inputs);
  const baseline = { generation: mix.generation, micGeneration: mix.micGeneration,
    revision: calibration.confirmedRevision, authorityRevision: timing.authorityRevision,
    ticket: mic.mediaTicket, transport: mic.audioTransport, leaseRevision: participants.revision };
  function activate(participantId: string, generation: number) {
    const socket = realSocket(participantId);
    const lease = participantId === 'participant-alice' ? participants.acquireMic(participantId)
      : participants.takeoverMic(participantId, participants.micOwnerId);
    assert.equal(lease.ok, true);
    workflow.activate({ socket, ownershipEffects: lease.changed ? lease.effects : null,
      previousOwnerId: lease.previousOwnerId, takeoverRequested: participantId !== 'participant-alice',
      sampleRate: 48_000, captureGeneration: generation, initialSequence: 11, audioPacketVersion: 2 });
    return socket;
  }
  function realSocket(participantId: string) { return socket('next', participantId); }
  return { workflow, old, participants, mic, mix, timing, calibration, context, take, quality,
    grace, control, baseline, activate, invalidationReasons, packet, expired,
    cleanup() { grace.cancel(); mic.clearMediaAuthority(control.now); calibration.reset(); } };
}
type RealFixture = ReturnType<typeof realFixture>;
function assertTakeIdentity(h: RealFixture) {
  assert.equal(h.take.lifecycle, 'recording'); assert.equal(h.take.recordingTakeId, 'matrix-take');
  assert.equal(h.mix.generation, h.baseline.generation);
  assert.equal(h.take.currentTake()?.mixSampleRange?.generation, h.baseline.generation);
  assert.equal(h.mix.alignment.calibratedMicLagMs, 250, 'admitted Take freezes applied alignment');
}

for (const generation of [7, 8]) test(`real owners same-participant capture ${generation} preserve Take and distinguish capture authority`, () => {
  const h = realFixture();
  try {
    const next = h.activate('participant-alice', generation);
    assert.equal(h.participants.micOwnerId, 'participant-alice');
    assert.equal(h.participants.revision, h.baseline.leaseRevision);
    assert.equal(h.mic.publisher, next); assert.equal(h.mic.mediaGeneration, generation);
    assert.equal(h.mic.mediaTicket === h.baseline.ticket, generation === 7);
    assert.equal(h.mic.audioTransport === h.baseline.transport, generation === 7);
    assert.equal(h.calibration.confirmedRevision, h.baseline.revision);
    assert.equal(h.timing.authorityRevision, h.baseline.authorityRevision);
    assert.equal(h.timing.authorityKind, 'content');
    assert.equal(h.calibration.isStaleFor(h.context()), generation !== 7);
    assert.deepEqual(h.invalidationReasons, generation === 7 ? [] : ['Microphone capture changed.']);
    assert.equal(h.quality.assessment().evidence.events['mic-capture-restarted'], generation === 7 ? 0 : 1);
    assertTakeIdentity(h);
  } finally { h.cleanup(); }
});

test('real owners cross-participant takeover retires old media, timing authority, and not the recording epoch', () => {
  const h = realFixture();
  try {
    const next = h.activate('participant-bob', 8);
    assert.equal(h.participants.micOwnerId, 'participant-bob');
    assert.equal(h.participants.revision, h.baseline.leaseRevision + 1);
    assert.equal(h.mic.publisher, next); assert.equal(h.mic.mediaOwnerId, 'participant-bob');
    assert.notEqual(h.mic.mediaTicket, h.baseline.ticket); assert.equal(h.old.replaced, true);
    assert.equal(h.calibration.confirmedResult, null); assert.equal(h.timing.authorityKind, 'none');
    assert.deepEqual(h.invalidationReasons, ['Microphone ownership changed.']);
    assert.equal(h.quality.assessment().evidence.events['mic-owner-changed'], 1);
    assert.equal(h.quality.assessment().evidence.events['mic-capture-restarted'], 1);
    assertTakeIdentity(h);
  } finally { h.cleanup(); }
});

test('real owners ignore a superseded old socket close and old-generation PCM', () => {
  const h = realFixture();
  try {
    const next = h.activate('participant-alice', 8), before = h.quality.assessment();
    assert.equal(h.workflow.disconnect(h.old), false);
    assert.deepEqual(h.mic.receivePublisher(h.old, h.packet, h.control.now), []);
    assert.deepEqual(h.mic.receiveDirectMedia(h.baseline.ticket, h.packet, h.control.now), []);
    assert.equal(h.mic.publisher, next); assert.equal(h.grace.pending, false);
    assert.deepEqual(h.quality.assessment(), before); assertTakeIdentity(h);
  } finally { h.cleanup(); }
});

test('real owners retain fresh WebTransport PCM and same-capture calibration after control loss and expiry', () => {
  const h = realFixture();
  try {
    h.control.direct = true;
    assert.equal(h.workflow.disconnect(h.old), true); assert.equal(h.mic.publisher, null);
    assert.equal(h.mic.authorizeDirectMedia(h.baseline.ticket), true);
    h.workflow.expire('participant-alice');
    assert.equal(h.participants.micOwnerId, 'participant-alice'); assert.equal(h.grace.pending, true);
    assert.equal(h.mic.mediaTicket, h.baseline.ticket); assert.equal(h.mic.audioTransport, h.baseline.transport);
    assert.equal(h.calibration.confirmedRevision, h.baseline.revision);
    assert.equal(h.timing.authorityKind, 'content'); assert.equal(h.timing.authorityRevision, h.baseline.authorityRevision);
    assert.equal(h.quality.assessment().evidence.events['mic-transport-disconnected'], 1);
    assert.equal(h.quality.assessment().evidence.events['mic-owner-changed'], 0);
    assertTakeIdentity(h);
  } finally { h.cleanup(); }
});

test('real owners expire stalled direct PCM then reject late old-ticket frames without splitting Take', async () => {
  const h = realFixture({ graceMs: 20 });
  let deadline!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('actual grace callback did not settle')), 1_000);
  });
  try {
    h.control.direct = true; h.workflow.disconnect(h.old); h.control.now += 1_001;
    assert.equal(await Promise.race([h.expired, timeout]), 'participant-alice');
    assert.equal(h.grace.pending, false); assert.equal(h.grace.ownerId, null);
    assert.equal(h.participants.micOwnerId, null); assert.equal(h.mic.mediaTicket, null);
    assert.equal(h.mic.authorizeDirectMedia(h.baseline.ticket), false);
    assert.deepEqual(h.mic.receiveDirectMedia(h.baseline.ticket, h.packet, h.control.now), []);
    assert.equal(h.calibration.confirmedResult, null); assert.equal(h.timing.authorityKind, 'none');
    assert.equal(h.quality.assessment().evidence.events['mic-owner-changed'], 1);
    assert.equal(h.quality.assessment().evidence.events['mic-capture-restarted'], 0);
    assertTakeIdentity(h);
  } finally { clearTimeout(deadline); h.cleanup(); }
});

test('real owners explicit release during recording retires media once and keeps Take identity', () => {
  const h = realFixture();
  try {
    const released = h.participants.releaseMic('participant-alice'); assert.equal(released.ok, true);
    h.workflow.release({ socket: h.old, participantId: 'participant-alice', effects: released.effects });
    assert.equal(h.participants.micOwnerId, null); assert.equal(h.mic.publisher, null);
    assert.equal(h.mic.mediaOwnerId, null); assert.equal(h.mic.mediaTicket, null); assert.equal(h.grace.pending, false);
    assert.equal(h.calibration.confirmedResult, null); assert.equal(h.timing.authorityKind, 'none');
    assert.equal(h.quality.assessment().evidence.events['mic-owner-changed'], 1);
    assert.equal(h.quality.assessment().evidence.events['mic-transport-disconnected'], 0);
    assertTakeIdentity(h);
  } finally { h.cleanup(); }
});

// C1 additions; C0's 33 literal oracles above are retained without changes.
test('new Mic lifecycle construction reads no canonical facts and invokes no effect or scheduler', () => {
  const poison = new Proxy({}, { get(_target, name) { throw new Error(`constructor touched ${String(name)}`); } });
  const dependencies = Object.fromEntries(['clock', 'participants', 'mic', 'mix', 'grace',
    'backing', 'calibration', 'take', 'queries', 'commands', 'effects'].map(name => [name, poison]));
  const owner = createRelayMicLifecycle(dependencies as RelayMicLifecycleDependencies<Socket>);
  assert.deepEqual(Object.keys(owner).sort(), ['activate', 'clearMediaAuthority', 'disconnect', 'expire', 'release', 'restartCapture']);
});

test('new Mic lifecycle reuses all three order coordinators and does not create domain state or a second scheduler', () => {
  const module = parseTypeScriptSource(new URL('../src/relay-mic-lifecycle.ts', import.meta.url),
    readFileSync(new URL('../src/relay-mic-lifecycle.ts', import.meta.url), 'utf8'));
  const code = sourceCode(module);
  for (const path of ['./relay-publisher-activation-coordinator.js', './relay-mic-release-coordinator.js',
    './relay-mic-disconnect-coordinator.js']) assert.ok(importSources(module).includes(path));
  assert.doesNotMatch(code, /new (?:ParticipantSession|MicRuntime|MicTransportGraceRuntime|AudioSession|CalibrationSession|TakeController)/);
  assert.doesNotMatch(code, /\b(?:setInterval|setTimeout|clearInterval|clearTimeout|await|ServerContext|registry|any|getState)\b/);
  assert.doesNotMatch(code, /from ['"].*(?:server|public\/)/);
  assert.doesNotMatch(code, /\blet\s+(?:publisher|micOwner|generation|ticket|timer|alignment|calibrationKind)/);
});

test('actual socket close preserves replacement fence, dispatch order, wall clock, and outer session publication', () => {
  const text = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = text.indexOf("socket.on('close', () => {");
  const end = text.indexOf("\n  });\n});\n\nwss.on('close'", start);
  assert.ok(start >= 0 && end > start);
  const body = text.slice(start + "socket.on('close', () => {".length, end);
  for (const replaced of [false, true]) for (const changed of [false, true])
    for (const connection of [false, true]) {
      const events: string[] = [];
      const inputs = {
        socket: { replaced, participantConnectionId: connection ? 'connection-1' : null },
        relaySongLifecycle: { disconnect: () => events.push('playback') },
        relayRobotMapping: { disconnectSource: () => events.push('robot') },
        relayMicLifecycle: { disconnect: () => { events.push('mic'); return changed; } },
        backingDisconnectCoordinator: { handle: () => events.push('backing') },
        participants: { detach: (id: string, now: number) => {
          assert.equal(id, 'connection-1'); assert.equal(now, 99); events.push('presence'); return changed; } },
        Date: { now: () => { events.push('wall-clock'); return 99; } },
        broadcastSessionStatus: () => events.push('session'),
      };
      new Function(...Object.keys(inputs), body)(...Object.values(inputs));
      assert.deepEqual(events, ['playback', ...(!replaced ? ['robot', 'mic', 'backing'] : []),
        ...(connection ? ['wall-clock', 'presence'] : []),
        ...(changed && (connection || !replaced) ? ['session'] : [])]);
    }
});

const productionServer = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));

function actualComposition(h: Fixture, capture?: (d: RelayMicLifecycleDependencies<Socket>) => void): Workflow {
  const inputs = { ...h.inputs,
    abandonProbeRun: unexpectedRestartEffect, clearContentValidationBaseline: unexpectedRestartEffect,
    syncAppliedCalibration: unexpectedRestartEffect,
    micRuntime: { ...h.inputs.micRuntime,
      // Preserve live getters; spreading the fixture alone would cache these.
      get publisher() { return h.state.publisher; },
      get mediaOwnerId() { return h.state.mediaOwner; },
      get audioTransport() { return h.state.transport; },
      get mediaTicket() { return h.state.ticket; },
      directMediaConnected: h.inputs.webTransportMicConnected, streaming: h.inputs.micStreaming },
    createRelayMicLifecycle: (d: RelayMicLifecycleDependencies<Socket>) => {
      assert.equal(d.participants, h.inputs.participants);
      assert.equal(d.mic, inputs.micRuntime);
      assert.equal(d.mix, h.inputs.session);
      assert.equal(d.grace, h.inputs.micTransportGrace);
      assert.equal(d.backing, h.inputs.backingRuntime);
      assert.equal(d.calibration, h.inputs.calibration);
      assert.equal(d.take, h.inputs.takeController);
      assert.equal(d.commands.applyOwnershipEffects, h.inputs.applyMicOwnerEffects);
      assert.equal(d.commands.cancelActiveContentValidation, h.inputs.cancelActiveContentValidation);
      assert.equal(d.queries.participantPayload, h.inputs.participantPayload);
      capture?.(d);
      return createRelayMicLifecycle(d);
    } };
  const code = variableInitializerCode(productionServer, 'relayMicLifecycle').replace('<RelaySocket>', '');
  return new Function(...Object.keys(inputs), `return (${code});`)(...Object.values(inputs)) as Workflow;
}

test('production Mic composition is unique, binds canonical owners, and precedes pump and first await', () => {
  const code = sourceCode(productionServer), at = code.indexOf('const relayMicLifecycle =');
  assert.equal(Array.from(code.matchAll(/createRelayMicLifecycle<RelaySocket>\(/g)).length, 1);
  for (const name of ['participants', 'micRuntime', 'session', 'micTransportGrace', 'backingRuntime',
    'calibration', 'takeController', 'micLevel']) {
    const owner = code.indexOf(`const ${name} =`);
    assert.ok(owner >= 0 && owner < at, `${name} before lifecycle`);
  }
  assert.doesNotMatch(code.slice(0, at), /\bawait\b/);
  assert.ok(at < code.indexOf('relayMixPump.start();'));
  for (const name of ['retirePublisherTransport', 'revokePublisherTransport',
    'restartLiveSourceAfterMicReconnect', 'maybeStopLiveSourceWhenUnarmed']) {
    assert.equal(hasFunction(productionServer, name), false);
  }
  for (const path of ['./relay-publisher-activation-coordinator.js',
    './relay-mic-release-coordinator.js', './relay-mic-disconnect-coordinator.js']) {
    assert.equal(importSources(productionServer).includes(path), false);
  }
  const h = fixture();
  actualComposition(h);
  assert.deepEqual(h.events, [], 'canonical assembly is inert');
});

test('actual production composition preserves complete activation/release/disconnect and wire traces', () => {
  for (const options of [{}, { captureReplaced: true, validationChanged: true },
    { collecting: true, direct: true }, { backingConnected: false }]) {
    for (const entry of ['activate', 'release', 'disconnect'] as const) {
      const a = fixture(options), b = fixture(options), owner = actualComposition(b);
      if (entry === 'activate') {
        a.workflow.activate(activation(a, a.effects)); owner.activate(activation(b, b.effects));
      } else if (entry === 'release') {
        a.workflow.release({ socket: a.old, participantId: 'participant-alice', effects: a.effects });
        owner.release({ socket: b.old, participantId: 'participant-alice', effects: b.effects });
      } else {
        assert.equal(owner.disconnect(b.old), a.workflow.disconnect(a.old));
      }
      assert.deepEqual(b.events, a.events, `${entry}: full trace`);
      assert.deepEqual(b.state, a.state, `${entry}: state`);
      assert.deepEqual(b.sent, a.sent, `${entry}: complete wire payloads`);
    }
  }
});

test('actual clear and expiry wrappers forward once, preserve void and default clock without duplicate teardown', () => {
  const declarations = ['clearMicMediaAuthority', 'expireMicTransportGrace'].map(name =>
    functionCode(productionServer, name).replace(': string', ''));
  for (const options of [{ control: false }, { control: false, direct: true },
    { control: false, releaseOk: false }, { control: true }]) {
    for (const entry of ['clear', 'expire'] as const) {
      const a = fixture(options), b = fixture(options);
      const wrappers = new Function('relayMicLifecycle',
        `${declarations.join('\n')} return {clearMicMediaAuthority, expireMicTransportGrace};`)(actualComposition(b)) as {
          clearMicMediaAuthority(): void; expireMicTransportGrace(id: string): void };
      if (entry === 'clear') {
        assert.equal(wrappers.clearMicMediaAuthority(), undefined); a.workflow.clearMediaAuthority();
      } else {
        assert.equal(wrappers.expireMicTransportGrace('participant-alice'), undefined);
        a.workflow.expire('participant-alice');
      }
      assert.deepEqual(b.events, a.events); assert.deepEqual(b.state, a.state);
    }
  }
  for (const [name, command] of [['clearMicMediaAuthority', 'clearMediaAuthority()'],
    ['expireMicTransportGrace', 'expire(expectedOwnerId)']]) {
    const code = functionCode(productionServer, name);
    assert.equal(code.slice(code.indexOf('{') + 1, code.lastIndexOf('}')).trim(),
      `relayMicLifecycle.${command};`);
  }
});

test('actual release handler rejects missing identity or refused lease before lifecycle and passes admitted effects', () => {
  const callback = objectArrowCallbackCode(productionServer, 'commandProtocol', 'releaseMic');
  for (const mode of ['anonymous', 'refused', 'admitted'] as const) {
    const events: unknown[] = [], effects = {};
    const inputs = {
      participants: { releaseMic: (id: string) => { events.push(['lease', id]); return { ok: mode === 'admitted', effects }; } },
      relayMicLifecycle: { release: (value: unknown) => { events.push(['release', value]); } },
    };
    const handler = new Function(...Object.keys(inputs), `return ({${callback}}).releaseMic;`)(...Object.values(inputs)) as (s: Socket) => void;
    const socket = mode === 'anonymous' ? {} : { participantId: 'participant-alice' };
    handler(socket);
    assert.deepEqual(events, mode === 'anonymous' ? [] : mode === 'refused'
      ? [['lease', 'participant-alice']]
      : [['lease', 'participant-alice'], ['release', { socket, participantId: 'participant-alice', effects }]]);
  }
});

test('actual publisher handler keeps validation/CAS/role commit before activation and rejects without lifecycle effects', () => {
  const callback = objectArrowCallbackCode(productionServer, 'registrationProtocol', 'publisher')
    .replace('let ownershipEffects: Parameters<typeof applyMicOwnerTransitionEffects>[0] | null', 'let ownershipEffects')
    .replace('let previousOwnerId: string | null', 'let previousOwnerId');
  for (const mode of ['role-refused', 'invalid-rate', 'lease-refused', 'admitted', 'takeover'] as const) {
    const events: string[] = [], effects = {}, socket = { participantId: 'participant-bob' };
    const ownership = () => { events.push('lease'); return {
      ok: mode !== 'lease-refused', effects, previousOwnerId: 'participant-alice', reason: 'busy', ownerId: 'participant-alice' }; };
    const inputs = {
      canClaimSocketRole: () => { events.push('role'); return mode !== 'role-refused'; },
      legacyTestParticipantIdentityEnabled: () => false,
      validSampleRate: () => { events.push('rate'); return mode === 'invalid-rate' ? null : 48_000; },
      validCaptureGeneration: (value: number) => value, validAudioPacketVersion: () => 2,
      normalizeParticipantId: (value: string) => value,
      participants: { micOwnerId: 'participant-alice', revision: 12, acquireMic: ownership, takeoverMic: ownership },
      participantPayload: () => ({}), sessionStatusPayload: () => ({}),
      sendJson: () => { events.push('reply'); },
      commitSocketRole: () => { events.push('commit'); },
      relayMicLifecycle: { activate: (value: PublisherActivationRequest<Socket, object>) => {
        assert.equal(value.socket, socket); assert.equal(value.ownershipEffects, effects);
        assert.equal(value.previousOwnerId, 'participant-alice');
        assert.equal(value.takeoverRequested, mode === 'takeover');
        assert.equal(value.sampleRate, 48_000); assert.equal(value.captureGeneration, 7);
        assert.equal(value.initialSequence, 11); assert.equal(value.audioPacketVersion, 2);
        events.push('activate');
      } },
    };
    const handler = new Function(...Object.keys(inputs), `return ({${callback}}).publisher;`)(...Object.values(inputs)) as (s: Socket, p: object) => void;
    handler(socket, { sampleRate: 48_000, captureGeneration: 7, initialSequence: 11, audioPacketVersion: 2,
      ...(mode === 'takeover' ? { takeoverExpectedOwnerId: 'participant-alice' } : {}) });
    assert.deepEqual(events, mode === 'role-refused' ? ['role'] : mode === 'invalid-rate'
      ? ['role', 'rate', 'reply'] : mode === 'lease-refused'
      ? ['role', 'rate', 'lease', 'reply', 'reply'] : ['role', 'rate', 'lease', 'commit', 'activate']);
  }
});
