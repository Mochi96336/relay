import assert from 'node:assert/strict';
import test from 'node:test';

import { canChangeRoomSong } from '../public/playback-policy.js';
import { reduceSessionOwnership } from '../public/session-status-projection.js';

const playingRoom = {
  videoId: 'abcdefghijk',
  playbackLeaderParticipantId: 'participant-a',
  playbackTransportId: 'playback-a',
  playbackGeneration: 1,
  leaderConnected: true,
  leaderFresh: true,
  handoffState: 'idle',
};

test('a late held-Mic snapshot cannot overwrite a newer release', () => {
  const held = reduceSessionOwnership(null, {
    revision: 4,
    serverIncarnation: 'server-a',
    micOwnerId: 'participant-a',
  });
  const released = reduceSessionOwnership(held, {
    revision: 5,
    serverIncarnation: 'server-a',
    micOwnerId: null,
  });
  const lateHeld = reduceSessionOwnership(released, {
    revision: 4,
    serverIncarnation: 'server-a',
    micOwnerId: 'participant-a',
  });

  assert.equal(released?.micOwnerId, null);
  assert.equal(lateHeld, null);
});

test('a late released snapshot cannot reopen shared controls after Mic acquisition', () => {
  const released = reduceSessionOwnership(null, {
    revision: 8,
    serverIncarnation: 'server-a',
    micOwnerId: null,
  });
  const acquired = reduceSessionOwnership(released, {
    revision: 9,
    serverIncarnation: 'server-a',
    micOwnerId: 'participant-b',
  });
  const lateReleased = reduceSessionOwnership(acquired, {
    revision: 8,
    serverIncarnation: 'server-a',
    micOwnerId: null,
  });

  assert.equal(acquired?.micOwnerId, 'participant-b');
  assert.equal(lateReleased, null);
});

test('a server restart accepts its lower revision but retires the old incarnation', () => {
  const oldServer = reduceSessionOwnership(null, {
    revision: 12,
    serverIncarnation: 'server-a',
    micOwnerId: 'participant-a',
  });
  const newServer = reduceSessionOwnership(oldServer, {
    revision: 1,
    serverIncarnation: 'server-b',
    micOwnerId: null,
  });
  const lateOldServer = reduceSessionOwnership(newServer, {
    revision: 13,
    serverIncarnation: 'server-a',
    micOwnerId: 'participant-a',
  });

  assert.equal(newServer?.micOwnerId, null);
  assert.equal(lateOldServer, null);
});

test('observer controls open on release, close on acquire, and ignore a late release', () => {
  const free = reduceSessionOwnership(null, {
    revision: 20,
    serverIncarnation: 'server-a',
    micOwnerId: null,
  });
  assert.equal(canChangeRoomSong({
    role: 'observer',
    timeline: playingRoom,
    isMicOwner: false,
    isMicFree: free?.micOwnerId === null,
  }), true);

  const held = reduceSessionOwnership(free, {
    revision: 21,
    serverIncarnation: 'server-a',
    micOwnerId: 'participant-b',
  });
  assert.equal(canChangeRoomSong({
    role: 'observer',
    timeline: playingRoom,
    isMicOwner: false,
    isMicFree: held?.micOwnerId === null,
  }), false);

  const lateFree = reduceSessionOwnership(held, {
    revision: 20,
    serverIncarnation: 'server-a',
    micOwnerId: null,
  });
  assert.equal(lateFree, null);
  assert.equal(canChangeRoomSong({
    role: 'observer',
    timeline: playingRoom,
    isMicOwner: false,
    isMicFree: held?.micOwnerId === null,
  }), false);
});
