import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelaySongHandoffResultCoordinator } from '../src/relay-song-handoff-result-coordinator.js';

type Identity = { transportId: string };
type Plan = { handoffId: string };

function coordinatorFor(calls: string[], options?: { readyPlan?: Plan | null; defer?: boolean }) {
  return createRelaySongHandoffResultCoordinator<Identity, Plan>({
    markReady: (identity, handoffId, micOwnerId) => {
      calls.push(`mark-ready:${identity.transportId}:${handoffId}:${micOwnerId ?? 'none'}`);
      return options?.readyPlan === undefined ? { handoffId: String(handoffId) } : options.readyPlan;
    },
    defer: (identity, handoffId) => {
      calls.push(`defer:${identity.transportId}:${handoffId}`);
      return options?.defer ?? true;
    },
    sendCommit: (plan) => calls.push(`commit:${plan.handoffId}`),
    reportTimelineStatus: () => calls.push('timeline-status'),
    reportRoomStatus: () => calls.push('room-status'),
  });
}

test('ready handoff commits before publishing timeline and room status', () => {
  const calls: string[] = [];
  const accepted = coordinatorFor(calls).ready({
    identity: { transportId: 'tab-a' },
    handoffId: 'handoff-1',
    micOwnerId: 'participant-1',
  });

  assert.equal(accepted, true);
  assert.deepEqual(calls, [
    'mark-ready:tab-a:handoff-1:participant-1',
    'commit:handoff-1',
    'timeline-status',
    'room-status',
  ]);
});

test('ready handoff publishes nothing when SongSession rejects readiness', () => {
  const calls: string[] = [];
  const accepted = coordinatorFor(calls, { readyPlan: null }).ready({
    identity: { transportId: 'tab-a' },
    handoffId: 'handoff-2',
    micOwnerId: null,
  });

  assert.equal(accepted, false);
  assert.deepEqual(calls, ['mark-ready:tab-a:handoff-2:none']);
});

test('failed handoff publishes only after SongSession accepts deferral', () => {
  const calls: string[] = [];
  const accepted = coordinatorFor(calls).failed({
    identity: { transportId: 'tab-b' },
    handoffId: 'handoff-3',
  });

  assert.equal(accepted, true);
  assert.deepEqual(calls, [
    'defer:tab-b:handoff-3',
    'timeline-status',
    'room-status',
  ]);
});

test('failed handoff publishes nothing when deferral is rejected', () => {
  const calls: string[] = [];
  const accepted = coordinatorFor(calls, { defer: false }).failed({
    identity: { transportId: 'tab-b' },
    handoffId: 'handoff-4',
  });

  assert.equal(accepted, false);
  assert.deepEqual(calls, ['defer:tab-b:handoff-4']);
});
