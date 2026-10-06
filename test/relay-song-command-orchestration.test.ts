import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RoomSongCommandRuntime } from '../src/room-song-command-runtime.js';
import { PlaybackTransportRuntime } from '../src/playback-transport-runtime.js';
import { parseRoomSongCommand } from '../src/room-song-command.js';
import { SongSession } from '../src/song-session.js';
import { createRelaySongCommandOrchestration,
  type RelaySongCommandOrchestrationDependencies } from '../src/relay-song-orchestration.js';
import type { AcceptedRoomSongCommand } from '../src/room-song-command-session.js';
import type { PlaybackIdentity } from '../src/song-session.js';
import { functionCode, objectArrowCallbackCode, parseTypeScriptSource,
  variableInitializerCode } from './support/source-contract.js';

type Socket = { telemetryRejectedReason?: string; participantId?: string };
const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'));
const target: PlaybackIdentity = { participantId: 'participant-a', transportId: 'playback-a', generation: 7 };
const command: AcceptedRoomSongCommand = {
  commandId: 'command-seek-1', expectedRevision: 8, supersedesCommandId: 'command-prior',
  revision: 9, issuedByParticipantId: target.participantId, target,
  body: { action: 'seek', positionSeconds: 30,
    desired: { videoId: 'dQw4w9WgXcQ', positionSeconds: 30, state: 1,
      playbackRate: 1, mustApplyPosition: true, ended: false }, ownedMutations: [] },
};
type Workflow = {
  roomSongCommandApplyPayload(value: AcceptedRoomSongCommand): unknown;
  rejectRoomSongCommand(socket: Socket, id: unknown, reason: string): void;
  broadcastRoomSongCommandFailure(id: string, reason: string, nowMs?: number): void;
  cancelPendingRoomSongCommand(reason: string, nowMs?: number): boolean;
  reportRoomSongTelemetryRejected(socket: Socket, reason: string): void;
  reportTelemetryRejected(socket: Socket, reason: string): void;
  accept(input: { socket: Socket; command: AcceptedRoomSongCommand; duplicate: boolean; nowMs: number }): void;
  stepExpiry(nowMs: number): void;
  clientFailed(socket: Socket, payload: { commandId: unknown }): void;
  admit(socket: Socket, payload: Record<string, unknown>): void;
};
const names = ['rejectRoomSongCommand', 'cancelPendingRoomSongCommand',
  'reportRoomSongTelemetryRejected', 'reportTelemetryRejected'] as const;

type Dependencies = RelaySongCommandOrchestrationDependencies<Socket>;

// C2 executes the actual canonical server constructor, wrappers and handler.
// C0/C1 legacy evidence is archived; no dead legacy algorithm stays in tests.
function createWorkflow(inputs: object): Workflow {
  const declarations = names.map(name => functionCode(server, name)
    .replaceAll(': AcceptedRoomSongCommand', '').replaceAll(': RelaySocket', '')
    .replaceAll(': unknown', '').replaceAll(': string', ''));
  const initializer = variableInitializerCode(server, 'relaySongCommands')
    .replace('createRelaySongCommandOrchestration<RelaySocket>', 'createRelaySongCommandOrchestration');
  const timer = variableInitializerCode(server, 'youtubeTimelineTimer');
  const start = timer.indexOf('relaySongCommands.stepExpiry(nowMs);');
  assert.ok(start >= 0, 'actual command expiry call remains identifiable');
  const failed = objectArrowCallbackCode(server, 'commandProtocol', 'roomSongCommandFailed');
  const admission = objectArrowCallbackCode(server, 'commandProtocol', 'roomSongCommand')
    .replaceAll(' as Record<string, unknown>', '');
  const ports = { ...inputs, createRelaySongCommandOrchestration, parseRoomSongCommand };
  return new Function(...Object.keys(ports), `${declarations.join('\n')}
    const relaySongCommands = ${initializer};
    function stepExpiry(nowMs) { ${timer.slice(start, start + 'relaySongCommands.stepExpiry(nowMs);'.length)} }
    return { ${names.join(',')}, roomSongCommandApplyPayload: relaySongCommands.applyPayload,
      broadcastRoomSongCommandFailure: relaySongCommands.reportFailure,
      accept: relaySongCommands.accept, stepExpiry,
      clientFailed: ({${failed}}).roomSongCommandFailed, admit: ({${admission}}).roomSongCommand };
  `)(...Object.values(ports)) as Workflow;
}

function fixture(options: { pending?: 'same' | 'other' | 'none'; cancelled?: boolean;
  expired?: boolean; identity?: boolean; fail?: boolean; throwAt?: string } = {}) {
  const events: string[] = [], sent: unknown[] = [];
  const error = new Error('original effect failure');
  const note = (event: string) => { events.push(event); if (event === options.throwAt) throw error; };
  const pending = options.pending === 'none' ? null : options.pending === 'other'
    ? { ...command, commandId: 'command-newer' } : command;
  const inputs = {
    performance: { now: () => { note('clock'); return 42; } },
    participants: { get micOwnerId() { note('owner'); return 'participant-a'; } },
    participantPayload: (id: string | null) => { note(`participant:${id}`); return { nickname: 'Alice' }; },
    roomSongCommands: {
      get revision() { note('revision'); return 9; },
      cancelPending: () => { note('cancel'); return options.cancelled === false ? null : command; },
      sweep: (now: number) => { note(`sweep:${now}`); return options.expired ? command : null; },
      pendingForTarget: (identity: PlaybackIdentity, now: number) => {
        assert.equal(identity, target); note(`pending:${now}`); return pending;
      },
      fail: (identity: PlaybackIdentity, id: string) => {
        assert.equal(identity, target); assert.equal(id, command.commandId); note('fail'); return options.fail !== false;
      },
    },
    youtubeTimeline: {
      roomStatusPayload: (now?: number) => { note(`room:${now ?? 'default'}`); return { videoId: 'room', at: now ?? null }; },
      statusPayload: () => { note('timeline'); return { playbackLeaderParticipantId: 'leader-a' }; },
    },
    playbackTransport: {
      identity: (_socket: Socket) => { note('identity'); return options.identity === false ? null : target; },
      send: (identity: PlaybackIdentity, payload: unknown) => { assert.equal(identity, target); note('apply'); sent.push(payload); },
    },
    roomSongCommandStatusPayload: (now: number) => { note(`command-status:${now}`); return { type: 'command-status', at: now }; },
    sendJson: (_socket: Socket, payload: unknown) => { note('send'); sent.push(payload); },
    broadcastJson: (payload: unknown) => { note('broadcast'); sent.push(payload); },
  };
  return { workflow: createWorkflow(inputs), inputs, events, sent, error };
}

test('old command composition is inert and apply payload retains every envelope and desired-state field', () => {
  const h = fixture(); assert.deepEqual(h.events, []);
  assert.deepEqual(h.workflow.roomSongCommandApplyPayload(command), {
    type: 'room-song-command-apply', commandId: 'command-seek-1', revision: 9,
    supersedesCommandId: 'command-prior', issuedByParticipantId: 'participant-a',
    targetPlaybackTransportId: 'playback-a', targetPlaybackGeneration: 7,
    action: 'seek', positionSeconds: 30,
    desired: { videoId: 'dQw4w9WgXcQ', positionSeconds: 30, state: 1,
      playbackRate: 1, mustApplyPosition: true, ended: false }, ownedMutations: [],
  });
  assert.deepEqual(h.events, []);
});

for (const id of ['command-seek-1', '', 7, null, undefined]) test(`old command rejection preserves typeof-string admission: ${String(id)}`, () => {
  const h = fixture(); h.workflow.rejectRoomSongCommand({}, id, 'blocked');
  assert.deepEqual(h.events, ['revision', 'room:default', 'send']);
  assert.deepEqual(h.sent, [{ type: 'room-song-command-rejected',
    commandId: typeof id === 'string' ? id : null, reason: 'blocked',
    revision: 9, room: { videoId: 'room', at: null } }]);
});

for (const now of [undefined, 0, 73.5]) test(`old command failure preserves default/explicit clock: ${String(now)}`, () => {
  const h = fixture(); h.workflow.broadcastRoomSongCommandFailure('command-seek-1', 'failed', now);
  assert.deepEqual(h.events, [...(now === undefined ? ['clock'] : []), 'revision', `room:${now ?? 42}`, 'broadcast']);
  assert.deepEqual(h.sent, [{ type: 'room-song-command-failed-ack', commandId: 'command-seek-1',
    reason: 'failed', revision: 9, room: { videoId: 'room', at: now ?? 42 } }]);
});

for (const cancelled of [false, true]) test(`old cancellation preserves no-op/transaction order: ${cancelled}`, () => {
  const h = fixture({ cancelled }); assert.equal(h.workflow.cancelPendingRoomSongCommand('owner-changed'), cancelled);
  assert.deepEqual(h.events, cancelled ? ['clock', 'cancel', 'revision', 'room:42', 'broadcast', 'command-status:42', 'broadcast'] : ['clock', 'cancel']);
  assert.equal(h.sent.length, cancelled ? 2 : 0);
});

for (const pending of ['same', 'other', 'none'] as const) test(`old accepted command rechecks identity before delivery: ${pending}`, () => {
  const h = fixture({ pending }); h.workflow.accept({ socket: {}, command, duplicate: true, nowMs: 0 });
  assert.deepEqual(h.events, ['send', 'pending:0', ...(pending === 'same' ? ['apply'] : []), 'command-status:0', 'broadcast']);
  assert.deepEqual(h.sent[0], { type: 'room-song-command-accepted', commandId: 'command-seek-1', revision: 9, duplicate: true });
  if (pending === 'same') assert.deepEqual(h.sent[1], h.workflow.roomSongCommandApplyPayload(command));
});

for (const expired of [false, true]) test(`old tick command expiry preserves supplied epoch and failure-before-status: ${expired}`, () => {
  const h = fixture({ expired }); assert.equal(h.workflow.stepExpiry(0), undefined);
  assert.deepEqual(h.events, expired ? ['sweep:0', 'revision', 'room:0', 'broadcast', 'command-status:0', 'broadcast'] : ['sweep:0']);
  if (expired) assert.deepEqual(h.sent[0], { type: 'room-song-command-failed-ack', commandId: 'command-seek-1',
    reason: 'command-timeout', revision: 9, room: { videoId: 'room', at: 0 } });
});

for (const mode of ['no-identity', 'no-pending', 'wrong-id', 'fail-refused', 'admitted'] as const) test(`old client-failure handler gate: ${mode}`, () => {
  const h = fixture({ identity: mode !== 'no-identity', pending: mode === 'no-pending' ? 'none' : 'same', fail: mode !== 'fail-refused' });
  h.workflow.clientFailed({}, { commandId: mode === 'wrong-id' ? 'command-old' : command.commandId });
  assert.deepEqual(h.events, mode === 'no-identity' ? ['identity'] : [
    'identity', 'clock', 'pending:42',
    ...(['fail-refused', 'admitted'].includes(mode) ? ['fail'] : []),
    ...(mode === 'admitted' ? ['revision', 'room:42', 'broadcast', 'command-status:42', 'broadcast'] : []),
  ]);
});

test('old telemetry rejection reporters share one socket memory, preserve namespaces, and reset after acceptance', () => {
  const h = fixture(), socket: Socket = {};
  h.workflow.reportRoomSongTelemetryRejected(socket, 'blocked');
  h.workflow.reportRoomSongTelemetryRejected(socket, 'blocked');
  h.workflow.reportTelemetryRejected(socket, 'blocked');
  h.workflow.reportTelemetryRejected(socket, 'blocked');
  h.workflow.reportRoomSongTelemetryRejected(socket, 'blocked');
  // Execute the real production acceptance callback, not a test reimplementation.
  const source = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));
  const clear = objectArrowCallbackCode(source, 'telemetry', 'clearTelemetryRejection');
  new Function('socket', `({${clear}}).clearTelemetryRejection(socket)`)(socket);
  h.workflow.reportRoomSongTelemetryRejected(socket, 'blocked');
  assert.equal(socket.telemetryRejectedReason, 'room-song:blocked');
  assert.deepEqual(h.events, ['revision', 'send', 'timeline', 'owner', 'participant:participant-a',
    'send', 'revision', 'send', 'revision', 'send']);
  assert.deepEqual(h.sent, [
    { type: 'room-song-telemetry-rejected', reason: 'blocked', revision: 9 },
    { type: 'youtube-telemetry-rejected', reason: 'blocked', playbackLeaderParticipantId: 'leader-a', micOwner: { nickname: 'Alice' } },
    { type: 'room-song-telemetry-rejected', reason: 'blocked', revision: 9 },
    { type: 'room-song-telemetry-rejected', reason: 'blocked', revision: 9 },
  ]);
});

for (const throwAt of ['send', 'pending:42', 'apply']) test(`old acceptance preserves synchronous throw cutoff: ${throwAt}`, () => {
  const h = fixture({ throwAt });
  assert.throws(() => h.workflow.accept({ socket: {}, command, duplicate: false, nowMs: 42 }), error => error === h.error);
  assert.deepEqual(h.events, throwAt === 'send' ? ['send'] : throwAt === 'pending:42' ? ['send', 'pending:42'] : ['send', 'pending:42', 'apply']);
});

type OwnerSocket = Socket & {
  open: boolean; sent: Record<string, unknown>[];
  playbackParticipantId?: string; playbackTransportId?: string; playbackGeneration?: number;
};

function ownerFixture() {
  const socket: OwnerSocket = { open: true, sent: [] };
  const clients = [socket], broadcasts: Record<string, unknown>[] = [], replies: Record<string, unknown>[] = [];
  const commands = new RoomSongCommandRuntime(), songs = new SongSession();
  const playback = new PlaybackTransportRuntime<OwnerSocket>({
    clients: () => clients, isOpen: value => value.open,
    send: (value, payload) => value.sent.push(payload as Record<string, unknown>), micIntentMs: 10_000,
  });
  playback.register(socket, target);
  const telemetry = { videoId: 'dQw4w9WgXcQ', state: 1, currentTime: 10,
    duration: 200, playbackRate: 1, bufferedFraction: 0.5 };
  assert.deepEqual(songs.update(telemetry, target, target.participantId, 0), { accepted: true, leaderChanged: true });
  let nowMs = 0;
  const workflow = createWorkflow({
    ...fixture().inputs, roomSongCommands: commands, youtubeTimeline: songs, playbackTransport: playback,
    performance: { now: () => nowMs },
    roomSongCommandStatusPayload: (now: number) => commands.statusPayload(now),
    sendJson: (_socket: Socket, payload: Record<string, unknown>) => replies.push(payload),
    broadcastJson: (payload: Record<string, unknown>) => broadcasts.push(payload),
  });
  function begin(id: string, position: number, expectedRevision = 0, supersedesCommandId: string | null = null) {
    const parsed = parseRoomSongCommand({ commandId: id, expectedRevision, supersedesCommandId,
      action: 'seek', positionSeconds: position });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error('invalid owner fixture request');
    const result = commands.begin(parsed.request, target.participantId, target, target.participantId,
      songs.statusPayload(nowMs) as Record<string, unknown>, nowMs);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('owner rejected fixture');
    return result;
  }
  return { workflow, socket, clients, broadcasts, replies, commands, songs, playback, begin, telemetry,
    setNow: (value: number) => { nowMs = value; } };
}

test('real owners acknowledge an older accepted intent without delivering over the newer pending intent', () => {
  const h = ownerFixture(), older = h.begin('command-owner-old', 30);
  const newer = h.begin('command-owner-new', 60, 0, older.command.commandId);
  h.workflow.accept({ socket: h.socket, ...older, nowMs: 0 });
  assert.deepEqual(h.replies, [{ type: 'room-song-command-accepted', commandId: 'command-owner-old', revision: 1, duplicate: false }]);
  assert.equal(h.socket.sent.length, 0);
  assert.equal(h.commands.revision, 2);
  assert.equal(h.commands.pendingForTarget(target, 0)?.commandId, 'command-owner-new');
  h.workflow.accept({ socket: h.socket, ...newer, nowMs: 0 });
  assert.equal(h.socket.sent.length, 1);
  assert.equal(h.socket.sent[0].commandId, 'command-owner-new');
  assert.equal((h.socket.sent[0].desired as Record<string, unknown>).positionSeconds, 60);
  const duplicate = h.begin('command-owner-old', 30);
  assert.equal(duplicate.duplicate, true);
  h.workflow.accept({ socket: h.socket, ...duplicate, nowMs: 0 });
  assert.equal(h.socket.sent.length, 1);
  assert.equal(h.commands.revision, 2);
  assert.equal(h.replies[2].duplicate, true);
  assert.deepEqual(h.broadcasts.map(value => value.pendingCommandId), Array(3).fill('command-owner-new'));
});

test('real owner cancellation preserves revision history and an old duplicate does not revive delivery', () => {
  const h = ownerFixture(), accepted = h.begin('command-owner-cancel', 30);
  assert.equal(h.workflow.cancelPendingRoomSongCommand('owner-changed', 0), true);
  assert.equal(h.commands.revision, 1);
  assert.equal(h.commands.pendingForTarget(target, 0), null);
  assert.deepEqual(h.broadcasts.map(value => [value.type, value.commandId ?? null, value.pendingCommandId ?? null]), [
    ['room-song-command-failed-ack', 'command-owner-cancel', null], ['room-song-command-status', null, null],
  ]);
  const duplicate = h.begin('command-owner-cancel', 30);
  assert.equal(duplicate.duplicate, true);
  h.workflow.accept({ socket: h.socket, ...duplicate, nowMs: 0 });
  assert.equal(h.socket.sent.length, 0);
  assert.deepEqual(h.commands.gateTelemetry({ ...h.telemetry, currentTime: 30 }, target,
    h.songs.statusPayload(0) as Record<string, unknown>, 0), { ok: false, reason: 'command-required' });
  assert.equal(h.workflow.cancelPendingRoomSongCommand('owner-changed', 0), false);
  assert.equal(accepted.command.revision, 1);
});

test('real command deadline remains live at 4000ms and expires once strictly after it', () => {
  const h = ownerFixture(); h.begin('command-owner-timeout', 30);
  h.workflow.stepExpiry(4_000);
  assert.equal(h.broadcasts.length, 0);
  assert.equal(h.commands.pendingForTarget(target, 4_000)?.commandId, 'command-owner-timeout');
  h.workflow.stepExpiry(4_001);
  assert.deepEqual(h.broadcasts.map(value => [value.type, value.reason ?? null, value.revision]), [
    ['room-song-command-failed-ack', 'command-timeout', 1], ['room-song-command-status', null, 1],
  ]);
  h.workflow.stepExpiry(4_002);
  assert.equal(h.broadcasts.length, 2);
  assert.equal(h.commands.pendingForTarget(target, 4_002), null);
});

test('real reconnect generation cancels old pending proof without accepting its failure or moving the Song leader', () => {
  const h = ownerFixture(); h.begin('command-owner-reload', 30);
  h.playback.register(h.socket, { ...target, generation: 8 });
  h.workflow.clientFailed(h.socket, { commandId: 'command-owner-reload' });
  assert.equal(h.broadcasts.length, 0);
  assert.equal(h.commands.revision, 1);
  assert.equal(h.commands.pendingForTarget(target, 0), null);
  assert.equal(h.songs.statusPayload(0).playbackGeneration, 7);
  assert.equal(h.socket.sent.length, 0);
});

test('real stale transport cannot fail the current command; exact target can fail it only once', () => {
  const h = ownerFixture(); h.begin('command-owner-failure', 30);
  const stale: OwnerSocket = { open: true, sent: [] };
  h.playback.register(stale, { ...target, generation: 6 });
  h.clients.push(stale);
  h.workflow.clientFailed(stale, { commandId: 'command-owner-failure' });
  assert.equal(h.broadcasts.length, 0);
  assert.equal(h.commands.pendingForTarget(target, 0)?.commandId, 'command-owner-failure');
  h.workflow.clientFailed(h.socket, { commandId: 'command-owner-failure' });
  assert.deepEqual(h.broadcasts.map(value => [value.type, value.reason ?? null, value.revision]), [
    ['room-song-command-failed-ack', 'playback-failed', 1], ['room-song-command-status', null, 1],
  ]);
  h.workflow.clientFailed(h.socket, { commandId: 'command-owner-failure' });
  assert.equal(h.broadcasts.length, 2);
  assert.equal(h.songs.statusPayload(0).playbackGeneration, 7);
});

test('real transport routing cannot send an accepted old-generation command to a replacement socket', () => {
  const h = ownerFixture(), accepted = h.begin('command-owner-route', 30);
  h.playback.register(h.socket, { ...target, generation: 8 });
  h.workflow.accept({ socket: h.socket, ...accepted, nowMs: 0 });
  assert.equal(h.socket.sent.length, 0);
  assert.equal(h.replies.length, 1);
  // Delivery failure is not proof of application; the original command owner
  // remains pending until its own expiry or a new-generation lookup cancels it.
  assert.equal(h.commands.pendingForTarget(target, 0)?.commandId, 'command-owner-route');
  assert.equal(h.commands.revision, 1);
});

test('real owner transition keeps historical duplicate acknowledgement separate from live intent authority', () => {
  const h = ownerFixture(); h.begin('command-owner-epoch', 30);
  h.workflow.cancelPendingRoomSongCommand('mic-owner-changed', 0);
  const parsed = parseRoomSongCommand({ commandId: 'command-owner-epoch', expectedRevision: 0,
    action: 'seek', positionSeconds: 30 });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid epoch fixture');
  const room = h.songs.statusPayload(0) as Record<string, unknown>;
  const duplicate = h.commands.begin(parsed.request, target.participantId, target,
    'participant-b', room, 0);
  assert.equal(duplicate.ok, true);
  if (!duplicate.ok) throw new Error('historical duplicate unexpectedly rejected');
  assert.equal(duplicate.duplicate, true);
  h.workflow.accept({ socket: h.socket, ...duplicate, nowMs: 0 });
  assert.equal(h.socket.sent.length, 0);
  assert.equal(h.commands.pendingForTarget(target, 0), null);
  assert.equal(h.commands.revision, 1);
  assert.deepEqual(h.commands.begin({ ...parsed.request, commandId: 'command-owner-late', expectedRevision: 1 },
    target.participantId, target, 'participant-b', room, 0), { ok: false, reason: 'mic-owner-required' });
  assert.deepEqual(h.songs.update({ ...h.telemetry, currentTime: 30 }, target, 'participant-b', 0),
    { accepted: false, reason: 'mic-owner-required', leaderChanged: false });
  assert.equal(h.songs.statusPayload(0).serverTime, 10);
});

for (const mode of ['no-participant', 'no-identity', 'wrong-participant', 'invalid-command', 'owner-refused', 'admitted', 'duplicate'] as const) {
  test(`actual server command admission precedes assembly acceptance: ${mode}`, () => {
    const h = fixture({ identity: mode !== 'no-identity' });
    Object.assign(h.inputs.roomSongCommands, { begin: (...args: unknown[]) => {
      h.events.push('begin');
      assert.deepEqual(args, [
        { commandId: command.commandId, expectedRevision: 8, supersedesCommandId: null,
          body: { action: 'seek', positionSeconds: 30 } },
        'participant-a', target, 'participant-a', { playbackLeaderParticipantId: 'leader-a' }, 42,
      ]);
      return mode === 'owner-refused' ? { ok: false, reason: 'mic-owner-required' }
        : { ok: true, command, duplicate: mode === 'duplicate' };
    } });
    const workflow = createWorkflow(h.inputs);
    const socket: Socket = mode === 'no-participant' ? {} : { participantId: mode === 'wrong-participant' ? 'participant-b' : 'participant-a' };
    workflow.admit(socket, { commandId: command.commandId, expectedRevision: 8,
      action: mode === 'invalid-command' ? 'nonsense' : 'seek', positionSeconds: 30 });
    const accepted = ['admitted', 'duplicate'].includes(mode);
    assert.deepEqual(h.events, [
      ...(mode === 'no-participant' ? [] : ['identity']),
      ...(['owner-refused', 'admitted', 'duplicate'].includes(mode) ? ['clock', 'owner', 'timeline', 'begin'] : []),
      ...(accepted ? ['send', 'pending:42', 'apply', 'command-status:42', 'broadcast'] : ['revision', 'room:default', 'send']),
    ]);
    if (accepted) assert.deepEqual(h.sent[0], { type: 'room-song-command-accepted', commandId: command.commandId,
      revision: 9, duplicate: mode === 'duplicate' });
    else assert.deepEqual(h.sent[0], { type: 'room-song-command-rejected', commandId: command.commandId,
      reason: mode === 'no-participant' ? 'participant-required' : ['no-identity', 'wrong-participant'].includes(mode)
        ? 'playback-transport-required' : mode === 'invalid-command' ? 'invalid-command' : 'mic-owner-required',
      revision: 9, room: { videoId: 'room', at: null } });
  });
}

test('actual production constructor binds canonical owners and original query/effect functions without sampling', () => {
  const h = fixture();
  const initializer = variableInitializerCode(server, 'relaySongCommands')
    .replace('createRelaySongCommandOrchestration<RelaySocket>', 'createRelaySongCommandOrchestration');
  let bound: Dependencies | undefined;
  const ports = { ...h.inputs, createRelaySongCommandOrchestration: (dependencies: Dependencies) => { bound = dependencies; } };
  new Function(...Object.keys(ports), `return ${initializer};`)(...Object.values(ports));
  assert.ok(bound);
  assert.equal(bound.commands, h.inputs.roomSongCommands);
  assert.equal(bound.song, h.inputs.youtubeTimeline);
  assert.equal(bound.playback, h.inputs.playbackTransport);
  assert.equal(bound.participants, h.inputs.participants);
  assert.equal(bound.queries.participantPayload, h.inputs.participantPayload);
  assert.equal(bound.queries.commandStatusPayload, h.inputs.roomSongCommandStatusPayload);
  assert.equal(bound.effects.send, h.inputs.sendJson);
  assert.equal(bound.effects.broadcast, h.inputs.broadcastJson);
  assert.deepEqual(h.events, []);
  assert.equal(bound.clock.now(), 42);
  assert.deepEqual(h.events, ['clock']);
});

test('actual server has one live command assembly, thin wrappers and expiry at the original tick boundary', () => {
  const code = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal((code.match(/const relaySongCommands = createRelaySongCommandOrchestration</g) ?? []).length, 1);
  assert.doesNotMatch(code, /roomSongCommandAcceptanceCoordinator|createRelayRoomSongCommandAcceptanceCoordinator|expiredRoomSongCommand/);
  assert.ok(code.indexOf('const roomSongCommands =') < code.indexOf('const relaySongCommands ='));
  assert.ok(code.indexOf('const relaySongCommands =') < code.indexOf('const youtubeTimelineTimer ='));
  assert.ok(code.indexOf('const relaySongCommands =') < code.indexOf('await loadMonitorOpusEncoder'));
  for (const [name, entry] of [
    ['rejectRoomSongCommand', 'reject'], ['cancelPendingRoomSongCommand', 'cancelPending'],
    ['reportRoomSongTelemetryRejected', 'reportRoomTelemetryRejected'], ['reportTelemetryRejected', 'reportTelemetryRejected'],
  ]) {
    const wrapper = functionCode(server, name);
    assert.match(wrapper, new RegExp(`relaySongCommands\\.${entry}\\(`));
    assert.doesNotMatch(wrapper, /\b(?:if|broadcastJson|sendJson|roomSongCommands|youtubeTimeline)\b/);
  }
  assert.doesNotMatch(code, /function (?:roomSongCommandApplyPayload|broadcastRoomSongCommandFailure)\(/);
  assert.match(variableInitializerCode(server, 'relaySongLifecycle'), /commandOrchestration: relaySongCommands/);
  const source = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8'));
  assert.match(variableInitializerCode(source, 'registration'), /playback\.send\(identity, commandOrchestration\.applyPayload\(command\)\)/);
  assert.match(variableInitializerCode(source, 'disconnect'), /commandOrchestration\.reportFailure\(commandId, 'playback-disconnected', nowMs\)/);
  const timer = variableInitializerCode(server, 'youtubeTimelineTimer');
  const refresh = timer.indexOf('broadcastJson(youtubeTimeline.roomStatusPayload(nowMs))');
  const expiry = timer.indexOf('relaySongCommands.stepExpiry(nowMs)');
  const calibration = timer.indexOf('if (calibration.collecting)');
  const handoff = timer.indexOf('sweepPreparedSongHandoff(nowMs)');
  const presence = timer.indexOf('participants.sweep(Date.now())');
  assert.ok(refresh >= 0 && refresh < expiry && expiry < calibration && calibration < handoff && handoff < presence);
  assert.equal((timer.match(/relaySongCommands\.stepExpiry\(/g) ?? []).length, 1);
});
test('C1 constructor does not read owner truth, clock, query or publish', () => {
  const forbidden = new Proxy({}, { get: (_target, key) => { throw new Error(`unexpected constructor read: ${String(key)}`); } });
  const assembly = createRelaySongCommandOrchestration<Socket>({
    clock: forbidden as Dependencies['clock'], commands: forbidden as Dependencies['commands'],
    song: forbidden as Dependencies['song'], playback: forbidden as Dependencies['playback'],
    participants: forbidden as Dependencies['participants'], queries: forbidden as Dependencies['queries'],
    effects: forbidden as Dependencies['effects'],
  });
  assert.deepEqual(Object.keys(assembly).sort(), ['accept', 'applyPayload', 'cancelPending', 'failPending',
    'reject', 'reportFailure', 'reportRoomTelemetryRejected', 'reportTelemetryRejected', 'stepExpiry']);
});

test('C1 assembly cannot allocate domain truth, scheduler or replacement rejection memory', () => {
  const code = readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\bnew\s+(?:SongSession|RoomSongCommandRuntime|PlaybackTransportRuntime|Map|Set)\b/);
  assert.doesNotMatch(code, /\b(?:setInterval|setTimeout|queueMicrotask|async|await)\b/);
  assert.doesNotMatch(code, /from ['"][^'"]*(?:server|participant-session|audio-session|take-controller|calibration-session)[^'"]*['"]/);
  assert.doesNotMatch(code, /\b(?:any|ServerContext)\b/);
  const commandFactory = functionCode(parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url), code),
    'createRelaySongCommandOrchestration');
  for (const forbidden of ['begin', 'gateTelemetry', 'complete', 'register', 'update', 'markHandoffReady']) {
    assert.doesNotMatch(commandFactory, new RegExp(`\\b(?:commands|song|playback)\\.${forbidden}\\s*\\(`));
  }
});
