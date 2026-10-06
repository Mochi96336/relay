import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RelayYoutubeTelemetryAcceptanceInput } from '../src/relay-youtube-telemetry-acceptance-coordinator.js';
import { createRelaySongCommandOrchestration, createRelaySongLifecycle,
  type RelaySongLifecycleDependencies } from '../src/relay-song-orchestration.js';
import type { AcceptedRoomSongCommand } from '../src/room-song-command-session.js';
import { RoomSongCommandRuntime } from '../src/room-song-command-runtime.js';
import { PlaybackTransportRuntime } from '../src/playback-transport-runtime.js';
import { parseRoomSongCommand } from '../src/room-song-command.js';
import { SongSession, normalizePlaybackGeneration, normalizePlaybackTransportId,
  LEGACY_PLAYBACK_PARTICIPANT_ID, LEGACY_PLAYBACK_TRANSPORT_ID } from '../src/song-session.js';
import type { PlaybackIdentity, SongHandoffPlan } from '../src/song-session.js';
import { functionCode, objectArrowCallbackCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

type Socket = { telemetryRejectedReason?: string; participantId?: string; connectionIncarnation?: number };
type TelemetryInput = RelayYoutubeTelemetryAcceptanceInput<Socket, PlaybackIdentity>;
type Workflow = {
  handoffPayload(type: 'song-handoff-prepare' | 'song-handoff-commit', plan: SongHandoffPlan): unknown;
  sendHandoffPlan(type: 'song-handoff-prepare' | 'song-handoff-commit', plan: SongHandoffPlan): number;
  beginPreparedSongHandoff(participantId: string, nowMs?: number): boolean;
  sweepPreparedSongHandoff(nowMs: number): boolean;
  ready(input: { identity: PlaybackIdentity; handoffId: unknown; micOwnerId: string | null }): boolean;
  failed(input: { identity: PlaybackIdentity; handoffId: unknown }): boolean;
  continueRegistration(input: { socket: Socket; identity: PlaybackIdentity }): void;
  acceptTelemetry(input: TelemetryInput): void;
  disconnect(socket: Socket): boolean;
  lastTimelineBroadcastAtMs(): number;
};
const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
const target: PlaybackIdentity = { participantId: 'participant-b', transportId: 'playback-b', generation: 7 };
const previous: PlaybackIdentity = { participantId: 'participant-a', transportId: 'playback-a', generation: 3 };
const plan: SongHandoffPlan = { handoffId: 'song-handoff-8', revision: 12, target,
  videoId: 'dQw4w9WgXcQ', state: 1, serverTime: 30, playbackRate: 1.25 };
const command: AcceptedRoomSongCommand = { commandId: 'command-seek-1', expectedRevision: 8,
  supersedesCommandId: null, revision: 9, issuedByParticipantId: target.participantId, target,
  body: { action: 'seek', positionSeconds: 30, desired: { videoId: plan.videoId, state: 1,
    positionSeconds: 30, playbackRate: 1.25, mustApplyPosition: true, ended: false }, ownedMutations: ['seek'] } };
const timeline = { type: 'youtube-timeline-status', state: 1, videoId: plan.videoId, playbackRate: 1.25 };

const lifecycleSource = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));

// C2 evaluates the actual production constructors and live thin wrappers.
// Private wire helpers are inspected without adding a public lifecycle API.
function createWorkflow(inputs: object): Workflow {
  const declarations = ['handoffPayload', 'sendHandoffPlan'].map(name => functionCode(lifecycleSource, name)
    .replaceAll(": 'song-handoff-prepare' | 'song-handoff-commit'", '').replaceAll(': SongHandoffPlan', ''));
  const commandInitializer = variableInitializerCode(server, 'relaySongCommands')
    .replace('createRelaySongCommandOrchestration<RelaySocket>', 'createRelaySongCommandOrchestration');
  const lifecycleInitializer = variableInitializerCode(server, 'relaySongLifecycle')
    .replace('createRelaySongLifecycle<RelaySocket>', 'createRelaySongLifecycle');
  const wrappers = ['beginPreparedSongHandoff', 'sweepPreparedSongHandoff'].map(name => functionCode(server, name)
    .replaceAll(': string', '').replaceAll(': number', ''));
  const ports = { ...inputs, createRelaySongCommandOrchestration, createRelaySongLifecycle };
  return new Function(...Object.keys(ports), `let lastTelemetryTimelineBroadcastAtMs = -Infinity;
    const relaySongCommands = ${commandInitializer};
    const playback = playbackTransport;
    ${declarations.join('\n')}
    const relaySongLifecycle = ${lifecycleInitializer};
    ${wrappers.join('\n')}
    return { handoffPayload, sendHandoffPlan, beginPreparedSongHandoff,
      sweepPreparedSongHandoff, ready: relaySongLifecycle.ready, failed: relaySongLifecycle.failed,
      continueRegistration: relaySongLifecycle.continueRegistration, acceptTelemetry: relaySongLifecycle.acceptTelemetry,
      disconnect: relaySongLifecycle.disconnect, lastTimelineBroadcastAtMs: () => lastTelemetryTimelineBroadcastAtMs };
  `)(...Object.values(ports)) as Workflow;
}

function fixture(options: { select?: boolean; plan?: boolean; target?: boolean; expired?: boolean;
  ready?: boolean; defer?: boolean; pending?: boolean; fail?: boolean; detach?: boolean;
  identity?: boolean; revoked?: boolean; cancelledValidation?: boolean; completed?: boolean; throwAt?: string } = {}) {
  const events: string[] = [], sent: { channel: string; identity?: PlaybackIdentity; payload: unknown }[] = [];
  const error = new Error('original synchronous effect failure');
  const note = (event: string) => { events.push(event); if (event === options.throwAt) throw error; };
  let clock = 42;
  const inputs = {
    performance: { now: () => { const value = clock++; note(`clock:${value}`); return value; } },
    participants: { get micOwnerId() { note('owner'); return target.participantId; } },
    participantPayload: () => null,
    playbackTransport: {
      selectHandoffTarget: (id: string, now: number) => { note(`select:${id}:${now}`); return options.select === false ? null : target; },
      connected: (identity: PlaybackIdentity) => { assert.equal(identity, target); note('connected'); return true; },
      identity: (_socket: Socket) => { note('identity'); return options.identity === false ? null : target; },
      register: (_socket: Socket, identity: PlaybackIdentity) => { assert.equal(identity, target); note('register'); },
      send: (identity: PlaybackIdentity, payload: { type: string }) => {
        note(`direct:${payload.type}:${identity.transportId}`); sent.push({ channel: 'direct', identity, payload }); return 1;
      },
    },
    youtubeTimeline: {
      beginHandoff: (identity: PlaybackIdentity, owner: string, now: number) => {
        assert.equal(identity, target); assert.equal(owner, target.participantId); note(`begin:${now}`);
        return options.plan === false ? null : plan;
      },
      handoffTarget: () => { note('target'); return options.target === false ? null : target; },
      sweepHandoff: (connected: boolean, now: number, owner: string) => {
        assert.equal(connected, true); assert.equal(owner, target.participantId); note(`sweep:${now}`); return Boolean(options.expired);
      },
      markHandoffReady: (identity: PlaybackIdentity, id: unknown, owner: string | null) => {
        assert.equal(identity, target); assert.equal(id, plan.handoffId); assert.equal(owner, target.participantId);
        note('ready'); return options.ready === false ? null : plan;
      },
      deferHandoff: (identity: PlaybackIdentity, id: unknown) => {
        assert.equal(identity, target); assert.equal(id, plan.handoffId); note('defer'); return options.defer !== false;
      },
      handoffPlanForTarget: (identity: PlaybackIdentity) => {
        assert.equal(identity, target); note('plan'); return options.plan === false ? null : plan;
      },
      detach: (identity: PlaybackIdentity) => { assert.equal(identity, target); note('detach'); return options.detach !== false; },
      statusPayload: (now?: number) => { note(`timeline:${now ?? 'default'}`); return timeline; },
      roomStatusPayload: (now?: number) => { note(`room:${now ?? 'default'}`); return { type: 'room-song-status', at: now ?? null }; },
    },
    roomSongCommands: {
      get revision() { note('revision'); return 9; },
      pendingForTarget: (identity: PlaybackIdentity, now: number) => {
        assert.equal(identity, target); note(`pending:${now}`); return options.pending ? command : null;
      },
      fail: (identity: PlaybackIdentity, id: string) => {
        assert.equal(identity, target); assert.equal(id, command.commandId); note('fail'); return options.fail !== false;
      },
      complete: (id: string) => { assert.equal(id, command.commandId); note('complete'); return options.completed !== false; },
    },
    roomSongCommandStatusPayload: (now?: number) => {
      note(`command-status:${now ?? 'default'}`); return { type: 'room-song-command-status', at: now ?? null };
    },
    cancelActiveContentValidation: (now: number) => { note(`validation:${now}`); return Boolean(options.cancelledValidation); },
    revokeContentMappingOnRateChange: (rate: unknown) => { note(`revoke:${String(rate)}`); return Boolean(options.revoked); },
    timingCalibrationStatusPayload: () => { note('timing'); return { type: 'timing-status' }; },
    sendJson: (_socket: Socket, payload: { type: string }) => { note(`send:${payload.type}`); sent.push({ channel: 'socket', payload }); },
    broadcastJson: (payload: { type: string }) => { note(`broadcast:${payload.type}`); sent.push({ channel: 'broadcast', payload }); },
  };
  return { workflow: createWorkflow(inputs), inputs, events, sent, error };
}

test('old Song lifecycle composition is inert and handoff wire omits private target identity', () => {
  const h = fixture(); assert.deepEqual(h.events, []);
  assert.equal(h.workflow.lastTimelineBroadcastAtMs(), -Infinity);
  assert.deepEqual(h.workflow.handoffPayload('song-handoff-prepare', plan), {
    type: 'song-handoff-prepare', handoffId: 'song-handoff-8', revision: 12,
    videoId: 'dQw4w9WgXcQ', state: 1, serverTime: 30, playbackRate: 1.25,
  });
  assert.equal(h.workflow.sendHandoffPlan('song-handoff-commit', plan), 1);
  assert.deepEqual(h.events, ['direct:song-handoff-commit:playback-b']);
  assert.equal(h.sent[0].identity, target);
  assert.deepEqual(h.sent[0].payload, { type: 'song-handoff-commit', handoffId: 'song-handoff-8', revision: 12,
    videoId: 'dQw4w9WgXcQ', state: 1, serverTime: 30, playbackRate: 1.25 });
});

for (const mode of ['no-target', 'no-plan', 'accepted'] as const) for (const now of [undefined, 0]) {
  test(`old handoff begin preserves target/owner admission and default clock: ${mode}/${String(now)}`, () => {
    const h = fixture({ select: mode !== 'no-target', plan: mode !== 'no-plan' });
    assert.equal(h.workflow.beginPreparedSongHandoff(target.participantId, now), mode === 'accepted');
    const at = now ?? 42;
    assert.deepEqual(h.events, [ ...(now === undefined ? ['clock:42'] : []), `select:participant-b:${at}`,
      ...(mode === 'no-target' ? [] : ['owner', `begin:${at}`]),
      ...(mode === 'accepted' ? ['direct:song-handoff-prepare:playback-b', `timeline:${at}`, 'broadcast:youtube-timeline-status',
        `room:${at}`, 'broadcast:room-song-status'] : []) ]);
  });
}

for (const mode of ['no-target', 'live', 'expired'] as const) test(`old sweep preserves connected/owner query order: ${mode}`, () => {
  const h = fixture({ target: mode !== 'no-target', expired: mode === 'expired' });
  assert.equal(h.workflow.sweepPreparedSongHandoff(0), mode === 'expired');
  assert.deepEqual(h.events, ['target', ...(mode === 'no-target' ? [] : ['connected', 'owner', 'sweep:0']),
    ...(mode === 'expired' ? ['direct:song-handoff-cancelled:playback-b', 'timeline:0', 'broadcast:youtube-timeline-status',
      'room:0', 'broadcast:room-song-status'] : [])]);
  if (mode === 'expired') assert.deepEqual(h.sent[0], { channel: 'direct', identity: target, payload: { type: 'song-handoff-cancelled' } });
});

for (const ready of [false, true]) test(`old ready result publishes commit before separately sampled status queries: ${ready}`, () => {
  const h = fixture({ ready });
  assert.equal(h.workflow.ready({ identity: target, handoffId: plan.handoffId, micOwnerId: target.participantId }), ready);
  assert.deepEqual(h.events, ['ready', ...(ready ? ['direct:song-handoff-commit:playback-b', 'timeline:default',
    'broadcast:youtube-timeline-status', 'room:default', 'broadcast:room-song-status'] : [])]);
});

for (const defer of [false, true]) test(`old failed result publishes only after successful defer: ${defer}`, () => {
  const h = fixture({ defer }); assert.equal(h.workflow.failed({ identity: target, handoffId: plan.handoffId }), defer);
  assert.deepEqual(h.events, ['defer', ...(defer ? ['timeline:default', 'broadcast:youtube-timeline-status',
    'room:default', 'broadcast:room-song-status'] : [])]);
});

for (const pendingPlan of [false, true]) for (const pending of [false, true]) test(`old registration snapshots precede plan and fresh command recheck: ${pendingPlan}/${pending}`, () => {
  const h = fixture({ plan: pendingPlan, pending });
  assert.equal(h.workflow.continueRegistration({ socket: {}, identity: target }), undefined);
  assert.deepEqual(h.events, ['send:playback-registered', 'room:default', 'send:room-song-status',
    'command-status:default', 'send:room-song-command-status', 'plan',
    ...(pendingPlan ? ['direct:song-handoff-prepare:playback-b'] : []), 'clock:42', 'pending:42',
    ...(pending ? ['direct:room-song-command-apply:playback-b'] : [])]);
  assert.deepEqual(h.sent[0].payload, { type: 'playback-registered', playbackTransportId: 'playback-b', playbackGeneration: 7 });
  if (pending) assert.deepEqual(h.sent.at(-1)?.payload, {
    type: 'room-song-command-apply', commandId: 'command-seek-1', revision: 9, supersedesCommandId: null,
    issuedByParticipantId: 'participant-b', targetPlaybackTransportId: 'playback-b', targetPlaybackGeneration: 7,
    action: 'seek', positionSeconds: 30, desired: { videoId: 'dQw4w9WgXcQ', state: 1,
      positionSeconds: 30, playbackRate: 1.25, mustApplyPosition: true, ended: false }, ownedMutations: ['seek'],
  });
});

for (const mode of ['playing', 'paused-no-change', 'paused-cancelled', 'rate-revoked'] as const) test(`old accepted telemetry ordering and separate cadence clock: ${mode}`, () => {
  const h = fixture({ revoked: mode === 'rate-revoked', cancelledValidation: mode === 'paused-cancelled' });
  const socket: Socket = { telemetryRejectedReason: 'room-song:blocked' };
  const status = { ...timeline, state: mode === 'playing' ? 1 : 2 };
  assert.equal(h.workflow.acceptTelemetry({ socket, acceptedIdentity: target, nowMs: 0, timelineStatus: status }), undefined);
  assert.equal(socket.telemetryRejectedReason, undefined);
  assert.deepEqual(h.events, ['register', 'revoke:1.25',
    ...(['paused-no-change', 'paused-cancelled'].includes(mode) ? ['validation:0'] : []),
    ...(mode === 'paused-cancelled' ? ['timing', 'broadcast:timing-status'] : []),
    'clock:42', 'broadcast:youtube-timeline-status', 'room:0', 'broadcast:room-song-status']);
  assert.equal(h.workflow.lastTimelineBroadcastAtMs(), 42);
  assert.equal(h.sent.find(value => value.payload === status)?.payload, status);
});

for (const completed of [false, true]) test(`old command completion precedes handoff release/complete: ${completed}`, () => {
  const h = fixture({ completed });
  h.workflow.acceptTelemetry({ socket: {}, acceptedIdentity: target, nowMs: 0, timelineStatus: timeline,
    completesCommandId: command.commandId, handoffCompleted: true, handoffId: plan.handoffId, previousLeader: previous });
  assert.deepEqual(h.events, ['register', 'revoke:1.25', 'clock:42', 'broadcast:youtube-timeline-status',
    'room:0', 'broadcast:room-song-status', 'complete',
    ...(completed ? ['revision', 'broadcast:room-song-command-complete', 'command-status:0', 'broadcast:room-song-command-status'] : []),
    'direct:song-handoff-release:playback-a', 'direct:song-handoff-complete:playback-b']);
  assert.deepEqual(h.sent.slice(-2), [
    { channel: 'direct', identity: previous, payload: { type: 'song-handoff-release', handoffId: 'song-handoff-8', videoId: 'dQw4w9WgXcQ' } },
    { channel: 'direct', identity: target, payload: { type: 'song-handoff-complete', handoffId: 'song-handoff-8' } },
  ]);
});

for (const mode of ['no-id', 'not-completed', 'no-previous-holder', 'missing-video'] as const) test(`old handoff completion guards and release video fallback: ${mode}`, () => {
  const h = fixture();
  h.workflow.acceptTelemetry({ socket: {}, acceptedIdentity: target, nowMs: 0,
    timelineStatus: mode === 'missing-video' ? { ...timeline, videoId: undefined } : timeline,
    handoffCompleted: mode !== 'not-completed', handoffId: mode === 'no-id' ? '' : plan.handoffId,
    previousLeader: mode === 'no-previous-holder' ? null : previous });
  const release = mode === 'missing-video', complete = release || mode === 'no-previous-holder';
  assert.deepEqual(h.events, ['register', 'revoke:1.25', 'clock:42', 'broadcast:youtube-timeline-status',
    'room:0', 'broadcast:room-song-status', ...(release ? ['direct:song-handoff-release:playback-a'] : []),
    ...(complete ? ['direct:song-handoff-complete:playback-b'] : [])]);
  if (release) assert.deepEqual(h.sent.at(-2)?.payload, { type: 'song-handoff-release', handoffId: plan.handoffId, videoId: null });
});

for (const mode of ['unidentified', 'idle-stale', 'idle-detached', 'pending-refused', 'pending-failed'] as const) test(`old playback close retains command-before-detach ordering: ${mode}`, () => {
  const h = fixture({ identity: mode !== 'unidentified', pending: mode.startsWith('pending'),
    fail: mode !== 'pending-refused', detach: mode !== 'idle-stale' });
  assert.equal(h.workflow.disconnect({}), mode !== 'unidentified');
  assert.deepEqual(h.events, ['identity', ...(mode === 'unidentified' ? [] : [
    'clock:42', 'pending:42', ...(mode.startsWith('pending') ? ['fail'] : []),
    ...(mode === 'pending-failed' ? ['revision', 'room:42', 'broadcast:room-song-command-failed-ack',
      'command-status:42', 'broadcast:room-song-command-status'] : []), 'detach',
    ...(mode !== 'idle-stale' ? ['timeline:default', 'broadcast:youtube-timeline-status', 'room:default', 'broadcast:room-song-status'] : []),
  ])]);
});

for (const throwAt of ['direct:song-handoff-prepare:playback-b', 'broadcast:youtube-timeline-status']) test(`old begin preserves synchronous throw cutoff: ${throwAt}`, () => {
  const h = fixture({ throwAt });
  assert.throws(() => h.workflow.beginPreparedSongHandoff(target.participantId, 0), error => error === h.error);
  assert.deepEqual(h.events, ['select:participant-b:0', 'owner', 'begin:0', 'direct:song-handoff-prepare:playback-b',
    ...(throwAt === 'broadcast:youtube-timeline-status' ? ['timeline:0', 'broadcast:youtube-timeline-status'] : [])]);
});

test('old telemetry release throw preserves committed command publication and prevents target completion', () => {
  const h = fixture({ throwAt: 'direct:song-handoff-release:playback-a' }), socket: Socket = { telemetryRejectedReason: 'blocked' };
  assert.throws(() => h.workflow.acceptTelemetry({ socket, acceptedIdentity: target, nowMs: 0, timelineStatus: timeline,
    completesCommandId: command.commandId, handoffCompleted: true, handoffId: plan.handoffId, previousLeader: previous }), error => error === h.error);
  assert.equal(socket.telemetryRejectedReason, undefined);
  assert.deepEqual(h.events, ['register', 'revoke:1.25', 'clock:42', 'broadcast:youtube-timeline-status',
    'room:0', 'broadcast:room-song-status', 'complete', 'revision', 'broadcast:room-song-command-complete',
    'command-status:0', 'broadcast:room-song-command-status', 'direct:song-handoff-release:playback-a']);
});

type OwnerSocket = Socket & { open: boolean; sent: Record<string, unknown>[];
  playbackParticipantId?: string; playbackTransportId?: string; playbackGeneration?: number;
  playbackMicIntentAtMs?: number };

function ownerFixture() {
  const outgoing: OwnerSocket = { open: true, sent: [] }, incoming: OwnerSocket = { open: true, sent: [] };
  const clients = [outgoing, incoming], broadcasts: Record<string, unknown>[] = [];
  const songs = new SongSession(), commands = new RoomSongCommandRuntime();
  let now = 0, owner: string | null = target.participantId;
  const playback = new PlaybackTransportRuntime<OwnerSocket>({ clients: () => clients,
    isOpen: socket => socket.open, send: (socket, payload) => socket.sent.push(payload as Record<string, unknown>), micIntentMs: 10_000 });
  playback.register(outgoing, previous); playback.register(incoming, target);
  const telemetry = { videoId: plan.videoId, state: 1, currentTime: 10, duration: 200, playbackRate: 1, bufferedFraction: 0.8 };
  assert.deepEqual(songs.update(telemetry, previous, previous.participantId, 0), { accepted: true, leaderChanged: true });
  // Controlled owner clocks make the domain matrix deterministic. The literal
  // port tests above separately enforce omitted-vs-explicit call arguments.
  const songPorts = {
    beginHandoff: (identity: PlaybackIdentity, micOwner: string | null, at: number) => songs.beginHandoff(identity, micOwner, at),
    handoffTarget: () => songs.handoffTarget(),
    sweepHandoff: (connected: boolean, at: number, micOwner: string | null) => songs.sweepHandoff(connected, at, micOwner),
    markHandoffReady: (identity: PlaybackIdentity, id: unknown, micOwner: string | null) => songs.markHandoffReady(identity, id, micOwner, now),
    deferHandoff: (identity: PlaybackIdentity, id: unknown) => songs.deferHandoff(identity, id),
    handoffPlanForTarget: (identity: PlaybackIdentity) => songs.handoffPlanForTarget(identity, now),
    detach: (identity: PlaybackIdentity) => songs.detach(identity),
    statusPayload: (at = now) => songs.statusPayload(at),
    roomStatusPayload: (at = now) => songs.roomStatusPayload(at),
  };
  const inputs = { ...fixture().inputs, performance: { now: () => now }, participants: { get micOwnerId() { return owner; } },
    youtubeTimeline: songPorts, roomSongCommands: commands, playbackTransport: playback,
    roomSongCommandStatusPayload: (at = now) => commands.statusPayload(at),
    sendJson: (socket: OwnerSocket, payload: unknown) => socket.sent.push(payload as Record<string, unknown>),
    broadcastJson: (payload: unknown) => broadcasts.push(payload as Record<string, unknown>) };
  return { workflow: createWorkflow(inputs), songs, commands, playback, incoming, outgoing, clients, broadcasts, telemetry,
    setNow: (value: number) => { now = value; }, setOwner: (value: string | null) => { owner = value; } };
}

test('real prepare/ready retains the outgoing leader until matching PLAYING proof promotes atomically', () => {
  const h = ownerFixture(); assert.equal(h.workflow.beginPreparedSongHandoff(target.participantId, 0), true);
  const handoffId = h.incoming.sent[0].handoffId;
  assert.equal(h.songs.statusPayload(0).handoffState, 'preparing');
  assert.equal(h.songs.statusPayload(0).playbackLeaderParticipantId, previous.participantId);
  assert.deepEqual(h.songs.update(h.telemetry, target, target.participantId, 0),
    { accepted: false, reason: 'handoff-not-ready', leaderChanged: false });
  assert.equal(h.workflow.ready({ identity: target, handoffId, micOwnerId: target.participantId }), true);
  assert.equal(h.songs.statusPayload(0).handoffState, 'committing');
  assert.equal(h.songs.statusPayload(0).playbackTransportId, previous.transportId);
  const result = h.songs.update(h.telemetry, target, target.participantId, 0);
  assert.deepEqual(result, { accepted: true, leaderChanged: true, handoffCompleted: true,
    handoffId, previousLeader: previous });
  h.workflow.acceptTelemetry({ socket: h.incoming, acceptedIdentity: target, nowMs: 0,
    timelineStatus: h.songs.statusPayload(0), handoffCompleted: result.handoffCompleted,
    handoffId: result.handoffId, previousLeader: result.previousLeader });
  assert.equal(h.songs.statusPayload(0).handoffState, 'idle');
  assert.equal(h.songs.statusPayload(0).playbackGeneration, 7);
  assert.deepEqual(h.outgoing.sent, [{ type: 'song-handoff-release', handoffId, videoId: plan.videoId }]);
  assert.deepEqual(h.incoming.sent.map(value => value.type), ['song-handoff-prepare', 'song-handoff-commit', 'song-handoff-complete']);
});

test('real commit expiry cancels old handoff proof; later ordinary Mic-owner telemetry is not a synthetic handoff completion', () => {
  const h = ownerFixture(); h.workflow.beginPreparedSongHandoff(target.participantId, 0);
  const handoffId = h.incoming.sent[0].handoffId;
  assert.equal(h.workflow.ready({ identity: target, handoffId, micOwnerId: target.participantId }), true);
  assert.equal(h.workflow.sweepPreparedSongHandoff(5_000), false);
  assert.equal(h.workflow.sweepPreparedSongHandoff(5_001), true);
  assert.equal(h.songs.statusPayload(5_001).playbackLeaderParticipantId, previous.participantId);
  assert.equal(h.songs.statusPayload(5_001).handoffState, 'idle');
  const sentBefore = h.incoming.sent.length, broadcastsBefore = h.broadcasts.length;
  h.setNow(5_001);
  assert.equal(h.workflow.ready({ identity: target, handoffId, micOwnerId: target.participantId }), false);
  assert.equal(h.incoming.sent.length, sentBefore); assert.equal(h.broadcasts.length, broadcastsBefore);
  // The original 0A policy still permits this real Mic owner to establish a
  // normal leader after cancellation; expiry is not a blanket playback ban.
  const result = h.songs.update({ ...h.telemetry, currentTime: 15.001 }, target, target.participantId, 5_001);
  assert.deepEqual(result, { accepted: true, leaderChanged: true });
  h.workflow.acceptTelemetry({ socket: h.incoming, acceptedIdentity: target, nowMs: 5_001,
    timelineStatus: h.songs.statusPayload(5_001), handoffCompleted: result.handoffCompleted,
    handoffId: result.handoffId, previousLeader: result.previousLeader });
  assert.equal(h.incoming.sent.filter(value => value.type === 'song-handoff-complete').length, 0);
  assert.equal(h.outgoing.sent.length, 0);
  assert.equal(h.songs.statusPayload(5_001).playbackLeaderParticipantId, target.participantId);
});

test('real target reload invalidates old handoff identity while retaining the original whole-lifecycle deadline', () => {
  const h = ownerFixture(); h.workflow.beginPreparedSongHandoff(target.participantId, 100);
  const firstId = h.incoming.sent[0].handoffId;
  const reloaded = { ...target, generation: 8 };
  h.playback.register(h.incoming, reloaded); h.setNow(19_000);
  h.workflow.continueRegistration({ socket: h.incoming, identity: reloaded });
  const replayed = h.incoming.sent.findLast(value => value.type === 'song-handoff-prepare');
  assert.ok(replayed); assert.notEqual(replayed.handoffId, firstId);
  assert.equal(h.songs.handoffTarget()?.generation, 8);
  assert.equal(h.workflow.ready({ identity: target, handoffId: firstId, micOwnerId: target.participantId }), false);
  assert.deepEqual(h.songs.update(h.telemetry, target, target.participantId, 19_000),
    { accepted: false, reason: 'handoff-not-target', leaderChanged: false });
  h.setNow(19_100);
  assert.equal(h.workflow.ready({ identity: reloaded, handoffId: replayed.handoffId, micOwnerId: target.participantId }), true);
  assert.equal(h.workflow.failed({ identity: reloaded, handoffId: replayed.handoffId }), true);
  assert.equal(h.workflow.sweepPreparedSongHandoff(30_100), false);
  assert.equal(h.workflow.sweepPreparedSongHandoff(30_101), true);
  assert.equal(h.songs.statusPayload(30_101).handoffState, 'idle');
  assert.equal(h.songs.statusPayload(30_101).playbackLeaderParticipantId, previous.participantId);
  assert.equal(h.incoming.sent.at(-1)?.type, 'song-handoff-cancelled');
});

test('real outgoing transport closing after release cannot detach the promoted target', () => {
  const h = ownerFixture(); h.workflow.beginPreparedSongHandoff(target.participantId, 0);
  const handoffId = h.incoming.sent[0].handoffId;
  h.workflow.ready({ identity: target, handoffId, micOwnerId: target.participantId });
  const result = h.songs.update(h.telemetry, target, target.participantId, 0);
  assert.equal(result.handoffCompleted, true);
  h.workflow.acceptTelemetry({ socket: h.incoming, acceptedIdentity: target, nowMs: 0,
    timelineStatus: h.songs.statusPayload(0), handoffCompleted: result.handoffCompleted,
    handoffId: result.handoffId, previousLeader: result.previousLeader });
  const revision = h.songs.revision, broadcastsBefore = h.broadcasts.length;
  h.outgoing.open = false;
  assert.equal(h.workflow.disconnect(h.outgoing), true);
  assert.equal(h.songs.revision, revision); assert.equal(h.broadcasts.length, broadcastsBefore);
  assert.equal(h.songs.statusPayload(0).playbackTransportId, target.transportId);
  assert.equal(h.songs.statusPayload(0).leaderConnected, true);
});

test('real registration continuation sends only the current newer command intent', () => {
  const h = ownerFixture(); h.songs.detach(previous);
  assert.equal(h.songs.update(h.telemetry, target, target.participantId, 0).accepted, true);
  function begin(id: string, position: number, predecessor: string | null) {
    const parsed = parseRoomSongCommand({ commandId: id, expectedRevision: 0, supersedesCommandId: predecessor,
      action: 'seek', positionSeconds: position });
    assert.equal(parsed.ok, true); if (!parsed.ok) throw new Error('invalid registration intent fixture');
    const result = h.commands.begin(parsed.request, target.participantId, target, target.participantId,
      h.songs.statusPayload(0) as Record<string, unknown>, 0);
    assert.equal(result.ok, true); if (!result.ok) throw new Error('registration fixture rejected');
    return result.command;
  }
  const older = begin('command-register-old', 30, null), newer = begin('command-register-new', 60, older.commandId);
  h.workflow.continueRegistration({ socket: h.incoming, identity: target });
  const deliveries = h.incoming.sent.filter(value => value.type === 'room-song-command-apply');
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].commandId, newer.commandId);
  assert.equal(deliveries[0].revision, 2); assert.equal((deliveries[0].desired as Record<string, unknown>).positionSeconds, 60);
  assert.equal(h.commands.pendingForTarget(target, 0)?.commandId, newer.commandId);
  assert.equal(h.songs.statusPayload(0).serverTime, 10);
});

test('real timeout after Mic ownership left the target cannot mint holdover authority for an old epoch', () => {
  const h = ownerFixture(); h.workflow.beginPreparedSongHandoff(target.participantId, 100);
  const handoffId = h.incoming.sent[0].handoffId;
  h.setNow(150); h.workflow.ready({ identity: target, handoffId, micOwnerId: target.participantId });
  h.setOwner('participant-c');
  assert.equal(h.workflow.sweepPreparedSongHandoff(5_151), true);
  assert.equal(h.songs.statusPayload(5_151).playbackLeaderParticipantId, previous.participantId);
  assert.deepEqual(h.songs.update({ ...h.telemetry, currentTime: 15.151 }, previous, 'participant-c', 5_151),
    { accepted: false, reason: 'mic-owner-required', leaderChanged: false });
  h.setOwner(target.participantId);
  assert.deepEqual(h.songs.update({ ...h.telemetry, currentTime: 15.152 }, previous, target.participantId, 5_152),
    { accepted: false, reason: 'mic-owner-required', leaderChanged: false });
});
type Dependencies = RelaySongLifecycleDependencies<Socket>;

function actualHandler(name: string, ports: object): (socket: Socket, payload: Record<string, unknown>) => void {
  const callback = objectArrowCallbackCode(server, 'commandProtocol', name)
    .replaceAll(' as Record<string, unknown>', '');
  return new Function(...Object.keys(ports), `return ({${callback}}).${name};`)(...Object.values(ports));
}

for (const name of ['songHandoffReady', 'songHandoffFailed'] as const) for (const admitted of [false, true]) {
  test(`actual ${name} handler retains identity admission: ${admitted}`, () => {
    const events: string[] = [], socket: Socket = {};
    const input = { handoffId: plan.handoffId };
    const entry = name === 'songHandoffReady' ? 'ready' : 'failed';
    const handler = actualHandler(name, {
      playbackTransport: { identity: (value: Socket) => {
        assert.equal(value, socket); events.push('identity'); return admitted ? target : null;
      } },
      participants: { get micOwnerId() { events.push('owner'); return target.participantId; } },
      relaySongLifecycle: { [entry]: (value: unknown) => {
        events.push(entry);
        assert.deepEqual(value, { identity: target, handoffId: plan.handoffId,
          ...(entry === 'ready' ? { micOwnerId: target.participantId } : {}) });
      } },
    });
    handler(socket, input);
    assert.deepEqual(events, ['identity', ...(admitted ? [...(entry === 'ready' ? ['owner'] : []), entry] : [])]);
  });
}

for (const mode of ['no-participant', 'bad-transport', 'bad-generation', 'admitted'] as const) {
  test(`actual playbackHello registers before continuation: ${mode}`, () => {
    const events: string[] = [], socket: Socket = mode === 'no-participant' ? {} : { participantId: target.participantId };
    const handler = actualHandler('playbackHello', {
      normalizePlaybackTransportId, normalizePlaybackGeneration,
      sendJson: (value: Socket, payload: unknown) => {
        assert.equal(value, socket); events.push('invalid');
        assert.deepEqual(payload, { type: 'error', message: 'Invalid playback transport identity.' });
      },
      playbackTransport: { register: (value: Socket, identity: PlaybackIdentity) => {
        assert.equal(value, socket); assert.deepEqual(identity, target); events.push('register'); return target;
      } },
      relaySongLifecycle: { continueRegistration: (value: unknown) => {
        events.push('continue'); assert.deepEqual(value, { socket, identity: target });
      } },
    });
    handler(socket, { playbackTransportId: mode === 'bad-transport' ? '' : target.transportId,
      playbackGeneration: mode === 'bad-generation' ? -1 : target.generation });
    assert.deepEqual(events, mode === 'no-participant' ? [] : mode === 'admitted' ? ['register', 'continue'] : ['invalid']);
  });
}

for (const mode of ['not-publisher', 'invalid-identity', 'gate-refused', 'update-refused',
  'update-no-reason', 'registered', 'payload-identity', 'legacy'] as const) {
  test(`actual telemetry handler retains gate/update/snapshot ordering: ${mode}`, () => {
    const events: string[] = [], socket: Socket = ['not-publisher', 'legacy'].includes(mode)
      ? { connectionIncarnation: 23 } : { participantId: target.participantId };
    const expectedIdentity = mode === 'legacy' ? { participantId: LEGACY_PLAYBACK_PARTICIPANT_ID,
      transportId: LEGACY_PLAYBACK_TRANSPORT_ID, generation: 23 } : target;
    const payload = { ...timeline, playbackTransportId: mode === 'invalid-identity' ? '' : target.transportId,
      playbackGeneration: target.generation };
    const accepted = ['registered', 'payload-identity', 'legacy'].includes(mode);
    const handler = actualHandler('youtubeTelemetry', {
      normalizePlaybackTransportId, normalizePlaybackGeneration,
      LEGACY_PLAYBACK_PARTICIPANT_ID, LEGACY_PLAYBACK_TRANSPORT_ID,
      playbackTransport: { identity: (value: Socket) => {
        assert.equal(value, socket); events.push('identity'); return mode === 'registered' ? target : null;
      } },
      micRuntime: { isPublisher: (value: Socket) => {
        assert.equal(value, socket); events.push('publisher'); return mode === 'legacy';
      } },
      performance: { now: () => { events.push('clock'); return 0; } },
      participants: { get micOwnerId() { events.push('owner'); return target.participantId; } },
      roomSongCommands: { gateTelemetry: (value: unknown, identity: PlaybackIdentity, status: unknown, now: number) => {
        assert.equal(value, payload); assert.deepEqual(identity, expectedIdentity);
        assert.equal(status, timeline); assert.equal(now, 0); events.push('gate');
        return mode === 'gate-refused' ? { ok: false, reason: 'command-mismatch' }
          : { ok: true, completesCommandId: command.commandId };
      } },
      youtubeTimeline: {
        statusPayload: (now: number) => { assert.equal(now, 0); events.push('snapshot'); return timeline; },
        update: (value: unknown, identity: PlaybackIdentity, owner: string, now: number) => {
          assert.equal(value, payload); assert.deepEqual(identity, expectedIdentity);
          assert.equal(owner, target.participantId); assert.equal(now, 0); events.push('update');
          return accepted ? { accepted: true, handoffCompleted: true, handoffId: plan.handoffId, previousLeader: previous }
            : { accepted: false, reason: mode === 'update-no-reason' ? undefined : 'mic-owner-required' };
        },
      },
      reportTelemetryRejected: (value: Socket, reason: string) => { assert.equal(value, socket); events.push(`reject:${reason}`); },
      reportRoomSongTelemetryRejected: (value: Socket, reason: string) => { assert.equal(value, socket); events.push(`room-reject:${reason}`); },
      relaySongLifecycle: { acceptTelemetry: (value: unknown) => {
        events.push('accept'); assert.deepEqual(value, { socket, acceptedIdentity: expectedIdentity, nowMs: 0,
          timelineStatus: timeline, completesCommandId: command.commandId, handoffCompleted: true,
          handoffId: plan.handoffId, previousLeader: previous });
      } },
    });
    handler(socket, payload);
    const trace = mode === 'not-publisher' ? ['identity', 'publisher', 'reject:not-publisher']
      : mode === 'invalid-identity' ? ['identity', 'reject:invalid-identity']
      : ['identity', ...(mode === 'legacy' ? ['publisher'] : []), 'clock', 'snapshot', 'gate',
        ...(mode === 'gate-refused' ? ['room-reject:command-mismatch'] : ['owner', 'update',
          ...(accepted ? ['snapshot', 'accept'] : [`reject:${mode === 'update-no-reason' ? 'invalid-telemetry' : 'mic-owner-required'}`])])];
    assert.deepEqual(events, trace);
  });
}

test('actual lifecycle constructor uses canonical facets without reading live truth', () => {
  const h = fixture();
  const commandFacade = { applyPayload: () => null, reportFailure: () => {} };
  let bound: Dependencies | undefined;
  const ports = { ...h.inputs, relaySongCommands: commandFacade,
    createRelaySongLifecycle: (dependencies: Dependencies) => { bound = dependencies; } };
  const initializer = variableInitializerCode(server, 'relaySongLifecycle')
    .replace('createRelaySongLifecycle<RelaySocket>', 'createRelaySongLifecycle');
  new Function(...Object.keys(ports), `let lastTelemetryTimelineBroadcastAtMs = -Infinity; return ${initializer};`)(...Object.values(ports));
  assert.ok(bound);
  assert.equal(bound.participants, h.inputs.participants);
  assert.equal(bound.song, h.inputs.youtubeTimeline);
  assert.equal(bound.playback, h.inputs.playbackTransport);
  assert.equal(bound.commands, h.inputs.roomSongCommands);
  assert.equal(bound.commandOrchestration, commandFacade);
  assert.equal(bound.queries.commandStatusPayload, h.inputs.roomSongCommandStatusPayload);
  assert.equal(bound.crossCommands.cancelActiveContentValidation, h.inputs.cancelActiveContentValidation);
  assert.equal(bound.crossCommands.revokeContentMappingOnRateChange, h.inputs.revokeContentMappingOnRateChange);
  assert.equal(bound.effects.send, h.inputs.sendJson);
  assert.equal(bound.effects.broadcast, h.inputs.broadcastJson);
  assert.deepEqual(h.events, []);
  assert.equal(bound.clock.now(), 42);
  bound.effects.reportTimingStatus();
  assert.deepEqual(h.events, ['clock:42', 'timing', 'broadcast:timing-status']);
});

test('actual lifecycle is the only production composition and keeps original thin wrappers and tick', () => {
  const code = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal((code.match(/const relaySongLifecycle = createRelaySongLifecycle</g) ?? []).length, 1);
  assert.doesNotMatch(code, /(?:songHandoffResultCoordinator|playbackRegistrationContinuationCoordinator|youtubeTelemetryAcceptanceCoordinator|playbackDisconnectCoordinator)/);
  assert.doesNotMatch(code, /function (?:handoffPayload|sendHandoffPlan|roomSongCommandApplyPayload|broadcastRoomSongCommandFailure)\(/);
  assert.ok(code.indexOf('const relaySongCommands =') < code.indexOf('const relaySongLifecycle ='));
  assert.ok(code.indexOf('let lastTelemetryTimelineBroadcastAtMs =') < code.indexOf('const relaySongLifecycle ='));
  assert.ok(code.indexOf('const relaySongLifecycle =') < code.indexOf('const session = new AudioSession'));
  assert.ok(code.indexOf('const relaySongLifecycle =') < code.indexOf('const youtubeTimelineTimer ='));
  assert.ok(code.indexOf('const relaySongLifecycle =') < code.indexOf('await loadMonitorOpusEncoder'));
  const begin = functionCode(server, 'beginPreparedSongHandoff'), sweep = functionCode(server, 'sweepPreparedSongHandoff');
  assert.match(begin, /nowMs = performance\.now\(\)/);
  assert.match(begin, /return relaySongLifecycle\.prepare\(participantId, nowMs\)/);
  assert.match(sweep, /return relaySongLifecycle\.stepHandoff\(nowMs\)/);
  for (const wrapper of [begin, sweep]) assert.doesNotMatch(wrapper, /\b(?:if|youtubeTimeline|playbackTransport|broadcastJson)\b/);
  const timer = variableInitializerCode(server, 'youtubeTimelineTimer');
  assert.equal((timer.match(/sweepPreparedSongHandoff\(nowMs\)/g) ?? []).length, 1);
  assert.ok(timer.indexOf('relaySongCommands.stepExpiry(nowMs)') < timer.indexOf('sweepPreparedSongHandoff(nowMs)'));
  assert.ok(timer.indexOf('sweepPreparedSongHandoff(nowMs)') < timer.indexOf('participants.sweep(Date.now())'));
});

test('C1 lifecycle constructor reads no live truth, clock or effect and exposes only named transactions', () => {
  const forbidden = new Proxy({}, { get: (_target, key) => { throw new Error(`unexpected constructor read: ${String(key)}`); } });
  const lifecycle = createRelaySongLifecycle<Socket>({
    clock: forbidden as Dependencies['clock'], participants: forbidden as Dependencies['participants'],
    song: forbidden as Dependencies['song'], playback: forbidden as Dependencies['playback'],
    commands: forbidden as Dependencies['commands'], commandOrchestration: forbidden as Dependencies['commandOrchestration'],
    queries: forbidden as Dependencies['queries'], crossCommands: forbidden as Dependencies['crossCommands'],
    effects: forbidden as Dependencies['effects'],
  });
  assert.deepEqual(Object.keys(lifecycle).sort(), ['acceptTelemetry', 'continueRegistration', 'disconnect',
    'failed', 'prepare', 'ready', 'stepHandoff']);
});

test('C1 lifecycle cannot own domain instances, identity admission, cadence or new scheduling', () => {
  const code = functionCode(lifecycleSource, 'createRelaySongLifecycle');
  assert.doesNotMatch(code, /\bnew\s+(?:SongSession|RoomSongCommandRuntime|PlaybackTransportRuntime|Map|Set|WeakMap)\b/);
  assert.doesNotMatch(code, /\b(?:setInterval|setTimeout|queueMicrotask|async|await|any|ServerContext)\b/);
  assert.doesNotMatch(code, /lastTelemetryTimelineBroadcastAtMs|parseRoomSongCommand|normalizePlaybackGeneration|normalizePlaybackTransportId/);
  assert.doesNotMatch(code, /\b(?:song\.update|commands\.(?:begin|gateTelemetry))\s*\(/);
  assert.doesNotMatch(code, /from ['"][^'"]*server[^'"]*['"]/);
});
