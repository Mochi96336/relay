import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePlaybackRole } from '../public/song-role.js';

const self = {
  participantId: 'participant-self',
  transportId: 'playback-self-tab',
  playbackGeneration: 7,
};

function timeline(overrides: Record<string, unknown> = {}) {
  return {
    type: 'youtube-timeline-status',
    videoId: 'abcdefghijk',
    handoffState: 'idle',
    playbackLeaderParticipantId: 'participant-self',
    playbackTransportId: 'playback-self-tab',
    playbackGeneration: 7,
    handoffTargetParticipantId: null,
    handoffTargetPlaybackTransportId: null,
    handoffTargetPlaybackGeneration: null,
    ...overrides,
  };
}

test('waits for timeline identity before assigning a playback surface role', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: null,
    room: { videoId: 'abcdefghijk' },
  }), null);
});

test('empty room is an editable song surface', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({
      videoId: null,
      playbackLeaderParticipantId: null,
      playbackTransportId: null,
      playbackGeneration: null,
    }),
    room: { videoId: null },
  }), 'empty');
});

test('exact playback participant, transport and generation is the holder', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline(),
    room: { videoId: 'abcdefghijk' },
  }), 'holder');
});

test('another tab owned by the same participant remains an observer', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({ playbackTransportId: 'playback-other-tab' }),
    room: { videoId: 'abcdefghijk' },
  }), 'observer');
});

test('a newer generation of the same playback transport continues as holder after reload', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({ playbackGeneration: 6 }),
    room: { videoId: 'abcdefghijk' },
  }), 'holder');
});

test('an older page generation cannot claim a newer incarnation of the same transport', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({ playbackGeneration: 8 }),
    room: { videoId: 'abcdefghijk' },
  }), 'observer');
});

test('only the exact handoff target becomes preparing', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({
      playbackLeaderParticipantId: 'participant-other',
      playbackTransportId: 'playback-other',
      playbackGeneration: 2,
      handoffState: 'preparing',
      handoffTargetParticipantId: 'participant-self',
      handoffTargetPlaybackTransportId: 'playback-self-tab',
      handoffTargetPlaybackGeneration: 7,
    }),
    room: { videoId: 'abcdefghijk' },
  }), 'preparing');
});

test('a newer generation is not allowed to impersonate an exact handoff target', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({
      playbackLeaderParticipantId: 'participant-other',
      playbackTransportId: 'playback-other',
      playbackGeneration: 2,
      handoffState: 'preparing',
      handoffTargetParticipantId: 'participant-self',
      handoffTargetPlaybackTransportId: 'playback-self-tab',
      handoffTargetPlaybackGeneration: 6,
    }),
    room: { videoId: 'abcdefghijk' },
  }), 'observer');
});

test('old leader remains holder while a different exact target prepares', () => {
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({
      handoffState: 'preparing',
      handoffTargetParticipantId: 'participant-other',
      handoffTargetPlaybackTransportId: 'playback-other',
      handoffTargetPlaybackGeneration: 2,
    }),
    room: { videoId: 'abcdefghijk' },
  }), 'holder');
});

/**
 * Observer is a surface with no controls at all: no song form, no player, and
 * every command refused before it is sent. That is right while somebody is
 * driving the room and a trap once they stop. The server already accepts a
 * command against a disconnected or stale leader; this side used to compare
 * identities only, so a tab left open kept the room to itself for as long as it
 * existed.
 */
test('hands the room back when its leader stops holding it', () => {
  const foreignLeader = {
    playbackLeaderParticipantId: 'participant-other',
    playbackTransportId: 'playback-other-tab',
    playbackGeneration: 2,
  };

  // Still driving: nobody else may take the room from under them.
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({ ...foreignLeader, leaderConnected: true, leaderFresh: true }),
    room: { videoId: 'abcdefghijk' },
  }), 'observer');

  // Gone.
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({ ...foreignLeader, leaderConnected: false, leaderFresh: false }),
    room: { videoId: 'abcdefghijk' },
  }), 'empty');

  // Still connected but long past reporting, which is what a tab left open on
  // a locked phone looks like.
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({
      ...foreignLeader, leaderConnected: true, leaderFresh: false, ageMs: 30_000,
    }),
    room: { videoId: 'abcdefghijk' },
  }), 'empty');

  // A rebuffer is not an abdication: the controls must not flicker.
  assert.equal(resolvePlaybackRole({
    ...self,
    timeline: timeline({
      ...foreignLeader, leaderConnected: true, leaderFresh: false, ageMs: 2_000,
    }),
    room: { videoId: 'abcdefghijk' },
  }), 'observer');
});
