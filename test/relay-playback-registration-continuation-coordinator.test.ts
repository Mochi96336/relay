import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayPlaybackRegistrationContinuationCoordinator } from '../src/relay-playback-registration-continuation-coordinator.js';

type Identity = { participantId: string; transportId: string; generation: number };
type HandoffPlan = { handoffId: string };
type Command = { commandId: string };

test('playback registration continuation publishes snapshots then resumes pending work in order', () => {
  const calls: string[] = [];
  const identity: Identity = { participantId: 'p1', transportId: 't1', generation: 3 };
  const plan: HandoffPlan = { handoffId: 'handoff-1' };
  const command: Command = { commandId: 'command-1' };
  const coordinator = createRelayPlaybackRegistrationContinuationCoordinator<
    Record<string, never>,
    Identity,
    HandoffPlan,
    Command
  >({
    sendRegistered: (_socket, value) => calls.push(`registered:${value.transportId}:${value.generation}`),
    sendRoomStatus: () => calls.push('room-status'),
    sendCommandStatus: () => calls.push('command-status'),
    handoffPlanForTarget: (value) => {
      calls.push(`handoff-plan:${value.transportId}`);
      return plan;
    },
    sendHandoffPrepare: (value) => calls.push(`handoff-prepare:${value.handoffId}`),
    now: () => {
      calls.push('now');
      return 120;
    },
    pendingCommandForTarget: (value, nowMs) => {
      calls.push(`pending-command:${value.transportId}:${nowMs}`);
      return command;
    },
    sendCommandApply: (value, pending) => calls.push(`command-apply:${value.transportId}:${pending.commandId}`),
  });

  coordinator.continueRegistration({ socket: {}, identity });
  assert.deepEqual(calls, [
    'registered:t1:3',
    'room-status',
    'command-status',
    'handoff-plan:t1',
    'handoff-prepare:handoff-1',
    'now',
    'pending-command:t1:120',
    'command-apply:t1:command-1',
  ]);
});

test('playback registration continuation does not fabricate pending work', () => {
  const calls: string[] = [];
  const coordinator = createRelayPlaybackRegistrationContinuationCoordinator<
    Record<string, never>,
    Identity,
    HandoffPlan,
    Command
  >({
    sendRegistered: () => calls.push('registered'),
    sendRoomStatus: () => calls.push('room-status'),
    sendCommandStatus: () => calls.push('command-status'),
    handoffPlanForTarget: () => null,
    sendHandoffPrepare: () => calls.push('handoff-prepare'),
    now: () => 50,
    pendingCommandForTarget: () => null,
    sendCommandApply: () => calls.push('command-apply'),
  });

  coordinator.continueRegistration({
    socket: {},
    identity: { participantId: 'p1', transportId: 't1', generation: 1 },
  });
  assert.deepEqual(calls, ['registered', 'room-status', 'command-status']);
});
