import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SONG_CLOCK_BLOCKING_MS,
  SONG_CLOCK_LOST_MS,
  deriveRoomMicState,
  deriveRoomSongState,
  roomSongClockLost,
  roomSongClockSeverity,
} from '../src/room-domain.js';

test('Mic state separates lease, connectivity, first flow and current flow', () => {
  assert.equal(deriveRoomMicState({
    ownerId: null,
    connected: false,
    flowObserved: false,
    streaming: false,
  }), 'free');

  assert.equal(deriveRoomMicState({
    ownerId: 'participant-a',
    connected: true,
    flowObserved: false,
    streaming: false,
  }), 'starting');

  assert.equal(deriveRoomMicState({
    ownerId: 'participant-a',
    connected: true,
    flowObserved: true,
    streaming: true,
  }), 'live');

  assert.equal(deriveRoomMicState({
    ownerId: 'participant-a',
    connected: true,
    flowObserved: true,
    streaming: false,
  }), 'interrupted');

  assert.equal(deriveRoomMicState({
    ownerId: 'participant-a',
    connected: false,
    flowObserved: true,
    streaming: false,
  }), 'reconnecting');
});

test('Song state keeps short telemetry loss out of product failure semantics', () => {
  const recentlyMissing = {
    videoId: 'abcdefghijk',
    connected: false,
    clockAgeMs: 2_000,
    state: 1,
    handoffState: 'idle',
  };

  assert.equal(roomSongClockLost(recentlyMissing), false);
  assert.equal(deriveRoomSongState(recentlyMissing), 'playing');
  assert.equal(roomSongClockSeverity(recentlyMissing, true), null);
});

test('Song clock degradation and blocking use separate product thresholds', () => {
  const degraded = {
    videoId: 'abcdefghijk',
    connected: false,
    clockAgeMs: SONG_CLOCK_LOST_MS + 1,
    state: 1,
    handoffState: 'idle',
  };
  const blocked = {
    ...degraded,
    clockAgeMs: SONG_CLOCK_BLOCKING_MS + 1,
  };

  assert.equal(deriveRoomSongState(degraded), 'unavailable');
  assert.equal(roomSongClockSeverity(degraded, true), 'warning');
  assert.equal(roomSongClockSeverity(blocked, false), 'warning');
  assert.equal(roomSongClockSeverity(blocked, true), 'critical');
});

test('handoff remains a first-class Song state ahead of clock availability', () => {
  assert.equal(deriveRoomSongState({
    videoId: 'abcdefghijk',
    connected: false,
    clockAgeMs: SONG_CLOCK_BLOCKING_MS + 1,
    state: 1,
    handoffState: 'preparing',
  }), 'handoff');
});
