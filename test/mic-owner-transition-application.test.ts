import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { applyMicOwnerTransitionEffects } from '../src/mic-owner-transition-application.js';
import { micOwnerTransitionEffects } from '../src/mic-owner-transition.js';

function recorder(cancelled = true) {
  const calls: string[] = [];
  return {
    calls,
    port: {
      noteQualityEvent(event: string) { calls.push(`quality:${event}`); },
      cancelRoomSongCommand(reason: string) { calls.push(`command:${reason}`); },
      cancelSongHandoff() { calls.push('handoff:cancel'); return cancelled; },
      publishSongHandoffCancellation() { calls.push('handoff:publish'); },
      invalidateTiming(reason: string) { calls.push(`timing:${reason}`); },
      prepareSongHandoff(participantId: string) { calls.push(`handoff:prepare:${participantId}`); },
    },
  };
}

describe('mic owner transition application', () => {
  test('applies acquire effects in deterministic room order', () => {
    const { calls, port } = recorder();
    const result = applyMicOwnerTransitionEffects(
      micOwnerTransitionEffects({
        previousOwnerId: null,
        ownerId: 'participant-alice',
        cause: 'publisher-registration',
      }),
      port,
    );

    assert.deepEqual(calls, [
      'quality:mic-owner-changed',
      'command:mic-owner-changed',
      'timing:Microphone ownership changed.',
      'handoff:prepare:participant-alice',
    ]);
    assert.deepEqual(result, {
      applied: true,
      songHandoffCancelled: false,
      songHandoffPrepared: true,
    });
  });

  test('publishes cancellation only when a prepared handoff actually existed', () => {
    const effects = micOwnerTransitionEffects({
      previousOwnerId: 'participant-alice',
      ownerId: null,
      cause: 'explicit-release',
    });

    const present = recorder(true);
    assert.equal(applyMicOwnerTransitionEffects(effects, present.port).songHandoffCancelled, true);
    assert.deepEqual(present.calls, [
      'quality:mic-owner-changed',
      'command:mic-owner-released',
      'handoff:cancel',
      'handoff:publish',
      'timing:Microphone was released.',
    ]);

    const absent = recorder(false);
    assert.equal(applyMicOwnerTransitionEffects(effects, absent.port).songHandoffCancelled, false);
    assert.deepEqual(absent.calls, [
      'quality:mic-owner-changed',
      'command:mic-owner-released',
      'handoff:cancel',
      'timing:Microphone was released.',
    ]);
  });

  test('transport expiry keeps prepared playback handoff independent', () => {
    const { calls, port } = recorder();
    applyMicOwnerTransitionEffects(
      micOwnerTransitionEffects({
        previousOwnerId: 'participant-alice',
        ownerId: null,
        cause: 'transport-expired',
      }),
      port,
    );

    assert.deepEqual(calls, [
      'quality:mic-owner-changed',
      'command:mic-owner-released',
      'timing:Microphone transport did not reconnect before its grace period expired.',
    ]);
  });

  test('no-op transition performs no application work', () => {
    const { calls, port } = recorder();
    const result = applyMicOwnerTransitionEffects(
      micOwnerTransitionEffects({
        previousOwnerId: 'participant-alice',
        ownerId: 'participant-alice',
        cause: 'publisher-registration',
      }),
      port,
    );
    assert.deepEqual(calls, []);
    assert.equal(result.applied, false);
  });
});
