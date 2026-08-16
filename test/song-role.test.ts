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
