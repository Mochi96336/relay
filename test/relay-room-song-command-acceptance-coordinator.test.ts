import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRoomSongCommandAcceptanceCoordinator } from '../src/relay-room-song-command-acceptance-coordinator.js';

type Target = { participantId: string; transportId: string; generation: number };
type Command = {
  commandId: string;
  revision: number;
  target: Target;
  body: { action: string };
};

const target: Target = { participantId: 'p1', transportId: 'playback-1', generation: 4 };
const command: Command = {
  commandId: 'command-1',
  revision: 7,
  target,
  body: { action: 'seek' },
};

test('accepted room-song command is acknowledged, rechecked, applied and published in order', () => {
  const calls: string[] = [];
  const coordinator = createRelayRoomSongCommandAcceptanceCoordinator<object, Target, Command>({
    sendAccepted: (_socket, commandId, revision, duplicate) => {
      calls.push(`accepted:${commandId}:${revision}:${duplicate}`);
    },
    pendingForTarget: (pendingTarget, nowMs) => {
      calls.push(`pending:${pendingTarget.transportId}:${nowMs}`);
      return command;
    },
    sendApply: (applyTarget, applied) => {
      calls.push(`apply:${applyTarget.transportId}:${applied.commandId}`);
    },
    reportStatus: (nowMs) => calls.push(`status:${nowMs}`),
  });

  coordinator.accept({ socket: {}, command, duplicate: false, nowMs: 120 });
  assert.deepEqual(calls, [
    'accepted:command-1:7:false',
    'pending:playback-1:120',
    'apply:playback-1:command-1',
    'status:120',
  ]);
});

test('superseded command is still acknowledged but is not applied after the pending recheck', () => {
  const calls: string[] = [];
  const coordinator = createRelayRoomSongCommandAcceptanceCoordinator<object, Target, Command>({
    sendAccepted: (_socket, commandId, revision, duplicate) => {
      calls.push(`accepted:${commandId}:${revision}:${duplicate}`);
    },
    pendingForTarget: () => ({ ...command, commandId: 'command-2', revision: 8 }),
    sendApply: () => calls.push('apply'),
    reportStatus: () => calls.push('status'),
  });

  coordinator.accept({ socket: {}, command, duplicate: false, nowMs: 121 });
  assert.deepEqual(calls, ['accepted:command-1:7:false', 'status']);
});

test('duplicate acceptance preserves the duplicate flag and may redeliver the still-pending command', () => {
  const calls: string[] = [];
  const coordinator = createRelayRoomSongCommandAcceptanceCoordinator<object, Target, Command>({
    sendAccepted: (_socket, _commandId, _revision, duplicate) => calls.push(`accepted:${duplicate}`),
    pendingForTarget: () => command,
    sendApply: () => calls.push('apply'),
    reportStatus: () => calls.push('status'),
  });

  coordinator.accept({ socket: {}, command, duplicate: true, nowMs: 122 });
  assert.deepEqual(calls, ['accepted:true', 'apply', 'status']);
});
