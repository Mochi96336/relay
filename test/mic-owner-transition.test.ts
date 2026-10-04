import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { micOwnerTransitionEffects } from '../src/mic-owner-transition.js';

describe('mic owner transition policy', () => {
  test('first acquire invalidates prior timing and prepares playback for the new owner', () => {
    assert.deepEqual(micOwnerTransitionEffects({
      previousOwnerId: null,
      ownerId: 'participant-alice',
      cause: 'publisher-registration',
    }), {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-changed',
      cancelSongHandoff: false,
      invalidateTimingReason: 'Microphone ownership changed.',
      restoreMicGainFor: 'participant-alice',
      prepareSongHandoffFor: 'participant-alice',
    });
  });

  test('confirmed takeover has the same room consequences as a fresh acquire', () => {
    assert.deepEqual(micOwnerTransitionEffects({
      previousOwnerId: 'participant-alice',
      ownerId: 'participant-bobby',
      cause: 'publisher-registration',
    }), {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-changed',
      cancelSongHandoff: false,
      invalidateTimingReason: 'Microphone ownership changed.',
      restoreMicGainFor: 'participant-bobby',
      prepareSongHandoffFor: 'participant-bobby',
    });
  });

  test('same-owner publisher reconnect has no room-level ownership effects', () => {
    assert.deepEqual(micOwnerTransitionEffects({
      previousOwnerId: 'participant-alice',
      ownerId: 'participant-alice',
      cause: 'publisher-registration',
    }), {
      changed: false,
      noteQualityEvent: null,
      cancelRoomSongCommand: null,
      cancelSongHandoff: false,
      invalidateTimingReason: null,
      restoreMicGainFor: null,
      prepareSongHandoffFor: null,
    });
  });

  test('explicit release cancels owner-bound Song work and abandons a prepared handoff', () => {
    assert.deepEqual(micOwnerTransitionEffects({
      previousOwnerId: 'participant-alice',
      ownerId: null,
      cause: 'explicit-release',
    }), {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-released',
      cancelSongHandoff: true,
      invalidateTimingReason: 'Microphone was released.',
      restoreMicGainFor: null,
      prepareSongHandoffFor: null,
    });
  });

  test('presence expiry is the same authority release with a different diagnostic reason', () => {
    assert.deepEqual(micOwnerTransitionEffects({
      previousOwnerId: 'participant-alice',
      ownerId: null,
      cause: 'presence-expired',
    }), {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-released',
      cancelSongHandoff: true,
      invalidateTimingReason: 'Microphone owner left the Relay session.',
      restoreMicGainFor: null,
      prepareSongHandoffFor: null,
    });
  });

  test('transport expiry preserves its distinct diagnostic and does not cancel an independent handoff', () => {
    assert.deepEqual(micOwnerTransitionEffects({
      previousOwnerId: 'participant-alice',
      ownerId: null,
      cause: 'transport-expired',
    }), {
      changed: true,
      noteQualityEvent: 'mic-owner-changed',
      cancelRoomSongCommand: 'mic-owner-released',
      cancelSongHandoff: false,
      invalidateTimingReason: 'Microphone transport did not reconnect before its grace period expired.',
      restoreMicGainFor: null,
      prepareSongHandoffFor: null,
    });
  });

  test('cannot manufacture a release transition when the room already had no owner', () => {
    assert.equal(micOwnerTransitionEffects({
      previousOwnerId: null,
      ownerId: null,
      cause: 'presence-expired',
    }).changed, false);
  });
});
