import assert from 'node:assert/strict';
import test from 'node:test';
import {
  roomSoundActionNote,
  roomSoundPresentation,
  roomSoundStableNote,
} from '../public/room-sound-presentation.js';

test('Room sound preserves start failure instead of collapsing it into user mute', () => {
  assert.deepEqual(
    roomSoundPresentation({ state: 'muted', phase: 'start-failed' }),
    {
      toggleKey: 'roomSound.turnOn',
      noteKey: 'roomSound.retry',
    },
  );
});

test('Room sound reports transport recovery even when playback state is otherwise audible', () => {
  assert.equal(
    roomSoundPresentation({ state: 'audible', phase: 'reconnecting' }).noteKey,
    'roomSound.reconnecting',
  );
  assert.equal(
    roomSoundPresentation({ state: 'audible', phase: 'buffering' }).noteKey,
    'roomSound.buffering',
  );
  assert.equal(
    roomSoundPresentation({ state: 'audible', phase: 'playing' }).noteKey,
    null,
  );
});

test('forced Room sound reasons remain dominant over transient phases', () => {
  assert.deepEqual(
    roomSoundPresentation({ state: 'mic-muted', phase: 'reconnecting' }),
    { toggleKey: 'roomSound.paused', noteKey: 'roomSound.pausedForMic' },
  );
  assert.deepEqual(
    roomSoundPresentation({ state: 'playback-muted', phase: 'buffering' }),
    { toggleKey: 'roomSound.paused', noteKey: 'roomSound.pausedForBacking' },
  );
  assert.deepEqual(
    roomSoundPresentation({ state: 'review-muted', phase: 'take-review' }),
    { toggleKey: 'roomSound.paused', noteKey: 'roomSound.pausedForRecording' },
  );
});

test('ready Room sound still asks for the browser interaction needed to start audio', () => {
  assert.deepEqual(
    roomSoundPresentation({ state: 'ready', phase: 'first-interaction' }),
    { toggleKey: 'roomSound.mute', noteKey: 'roomSound.enableHint' },
  );
});

test('stable Room sound reason and transient action feedback stay separate', () => {
  assert.equal(
    roomSoundStableNote({ state: 'muted', phase: 'start-failed' }),
    'roomSound.muted',
  );
  assert.equal(
    roomSoundActionNote({ state: 'muted', phase: 'start-failed' }),
    'roomSound.retry',
  );

  assert.equal(
    roomSoundStableNote({ state: 'mic-muted', phase: 'handoff-starting' }),
    'roomSound.pausedForMic',
  );
  assert.equal(
    roomSoundActionNote({ state: 'mic-muted', phase: 'handoff-starting' }),
    'roomSound.micTakeover',
  );

  assert.equal(roomSoundStableNote({ state: 'audible', phase: 'buffering' }), null);
  assert.equal(
    roomSoundActionNote({ state: 'audible', phase: 'buffering' }),
    'roomSound.buffering',
  );
  assert.equal(roomSoundActionNote({ state: 'audible', phase: 'playing' }), null);
});
