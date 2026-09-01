import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayPlaybackDisconnectCoordinator } from '../src/relay-playback-disconnect-coordinator.js';
import type { PlaybackIdentity } from '../src/song-session.js';

const IDENTITY: PlaybackIdentity = {
  participantId: 'participant-a',
  transportId: 'transport-a',
  generation: 7,
};

test('orders pending command failure before timeline detach with identity intact', () => {
  const socket = { id: 'socket-a' };
  const calls: string[] = [];
  const coordinator = createRelayPlaybackDisconnectCoordinator<typeof socket>({
    identity(candidate) {
      assert.equal(candidate, socket);
      calls.push('identity');
      return IDENTITY;
    },
    now() {
      calls.push('now');
      return 1234;
    },
    pendingCommand(identity, nowMs) {
      assert.equal(identity, IDENTITY);
      assert.equal(nowMs, 1234);
      calls.push('pending');
      return { commandId: 'command-a' };
    },
    failPending(identity, commandId) {
      assert.equal(identity, IDENTITY);
      assert.equal(commandId, 'command-a');
      calls.push('fail');
      return true;
    },
    reportCommandFailure(commandId, nowMs) {
      assert.equal(commandId, 'command-a');
      assert.equal(nowMs, 1234);
      calls.push('report-command');
    },
    detachTimeline(identity) {
      assert.equal(identity, IDENTITY);
      calls.push('detach');
      return true;
    },
    reportTimelineChanged() {
      calls.push('report-timeline');
    },
  });

  assert.equal(coordinator.handle(socket), true);
  assert.deepEqual(calls, [
    'identity',
    'now',
    'pending',
    'fail',
    'report-command',
    'detach',
    'report-timeline',
  ]);
});

test('ignores sockets without playback identity', () => {
  const calls: string[] = [];
  const coordinator = createRelayPlaybackDisconnectCoordinator<object>({
    identity() {
      calls.push('identity');
      return null;
    },
    now() { calls.push('now'); return 1; },
    pendingCommand() { calls.push('pending'); return null; },
    failPending() { calls.push('fail'); return true; },
    reportCommandFailure() { calls.push('report-command'); },
    detachTimeline() { calls.push('detach'); return true; },
    reportTimelineChanged() { calls.push('report-timeline'); },
  });

  assert.equal(coordinator.handle({}), false);
  assert.deepEqual(calls, ['identity']);
});

test('reports only effects that actually changed authority', () => {
  const calls: string[] = [];
  const coordinator = createRelayPlaybackDisconnectCoordinator<object>({
    identity() { return IDENTITY; },
    now() { return 55; },
    pendingCommand() { return { commandId: 'stale-command' }; },
    failPending() { calls.push('fail'); return false; },
    reportCommandFailure() { calls.push('report-command'); },
    detachTimeline() { calls.push('detach'); return false; },
    reportTimelineChanged() { calls.push('report-timeline'); },
  });

  assert.equal(coordinator.handle({}), true);
  assert.deepEqual(calls, ['fail', 'detach']);
});
