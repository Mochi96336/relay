import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayYoutubeTelemetryAcceptanceCoordinator } from '../src/relay-youtube-telemetry-acceptance-coordinator.js';

type Identity = { id: string };
type Socket = { id: string };

function coordinatorFor(calls: string[], options: {
  cancelValidation?: boolean;
  completeCommand?: boolean;
} = {}) {
  return createRelayYoutubeTelemetryAcceptanceCoordinator<Socket, Identity>({
    registerPlayback: (socket, identity) => calls.push(`register:${socket.id}:${identity.id}`),
    clearTelemetryRejection: (socket) => calls.push(`clear-rejection:${socket.id}`),
    cancelActiveContentValidation: (nowMs) => {
      calls.push(`cancel-validation:${nowMs}`);
      return options.cancelValidation === true;
    },
    reportTimingStatus: () => calls.push('timing-status'),
    reportTimelineStatus: (status) => calls.push(`timeline:${String(status.videoId ?? '')}`),
    reportRoomStatus: (nowMs) => calls.push(`room:${nowMs}`),
    completeRoomSongCommand: (commandId) => {
      calls.push(`complete-command:${commandId}`);
      return options.completeCommand !== false;
    },
    reportRoomSongCommandComplete: (commandId) => calls.push(`command-complete:${commandId}`),
    reportRoomSongCommandStatus: (nowMs) => calls.push(`command-status:${nowMs}`),
    releasePreviousLeader: (identity, handoffId, videoId) => {
      calls.push(`handoff-release:${identity.id}:${handoffId}:${String(videoId)}`);
    },
    completeHandoff: (identity, handoffId) => calls.push(`handoff-complete:${identity.id}:${handoffId}`),
  });
}

const socket = { id: 'socket' };
const acceptedIdentity = { id: 'accepted' };

test('accepted playing telemetry publishes timeline and room after transport registration', () => {
  const calls: string[] = [];
  coordinatorFor(calls).accept({
    socket,
    acceptedIdentity,
    nowMs: 10,
    timelineStatus: { state: 1, videoId: 'video' },
    completesCommandId: null,
    handoffCompleted: false,
    handoffId: null,
    previousLeader: null,
  });

  assert.deepEqual(calls, [
    'register:socket:accepted',
    'clear-rejection:socket',
    'timeline:video',
    'room:10',
  ]);
});

test('accepted non-playing telemetry invalidates active content validation before timeline publication', () => {
  const calls: string[] = [];
  coordinatorFor(calls, { cancelValidation: true }).accept({
    socket,
    acceptedIdentity,
    nowMs: 20,
    timelineStatus: { state: 2, videoId: 'video' },
    completesCommandId: null,
    handoffCompleted: false,
    handoffId: null,
    previousLeader: null,
  });

  assert.deepEqual(calls, [
    'register:socket:accepted',
    'clear-rejection:socket',
    'cancel-validation:20',
    'timing-status',
    'timeline:video',
    'room:20',
  ]);
});

test('Room Song completion publishes before handoff terminal messages', () => {
  const calls: string[] = [];
  coordinatorFor(calls).accept({
    socket,
    acceptedIdentity,
    nowMs: 30,
    timelineStatus: { state: 1, videoId: 'video' },
    completesCommandId: 'command-1',
    handoffCompleted: true,
    handoffId: 'handoff-1',
    previousLeader: { id: 'previous' },
  });

  assert.deepEqual(calls, [
    'register:socket:accepted',
    'clear-rejection:socket',
    'timeline:video',
    'room:30',
    'complete-command:command-1',
    'command-complete:command-1',
    'command-status:30',
    'handoff-release:previous:handoff-1:video',
    'handoff-complete:accepted:handoff-1',
  ]);
});

test('failed Room Song completion does not fabricate terminal command publication', () => {
  const calls: string[] = [];
  coordinatorFor(calls, { completeCommand: false }).accept({
    socket,
    acceptedIdentity,
    nowMs: 40,
    timelineStatus: { state: 1, videoId: 'video' },
    completesCommandId: 'command-2',
    handoffCompleted: false,
    handoffId: null,
    previousLeader: null,
  });

  assert.deepEqual(calls, [
    'register:socket:accepted',
    'clear-rejection:socket',
    'timeline:video',
    'room:40',
    'complete-command:command-2',
  ]);
});
