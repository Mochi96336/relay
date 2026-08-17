import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { SongSession } from '../src/song-session.js';

const VIDEO = 'dQw4w9WgXcQ';
const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const A_RELOAD = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 2 };
const A_OTHER_TAB = { participantId: 'participant-a', transportId: 'playback-tab-b', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-c', generation: 1 };

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
    ...overrides,
  };
}

describe('SongSession', () => {
  test('first valid transport becomes the invisible playback leader while the mic is free', () => {
    const songs = new SongSession();
    const result = songs.update(telemetry(), A, null, 100);

    assert.deepEqual(result, { accepted: true, leaderChanged: true });
    assert.deepEqual(songs.statusPayload(100), {
      ...(songs.statusPayload(100) as Record<string, unknown>),
      playbackLeaderParticipantId: 'participant-a',
      playbackTransportId: 'playback-tab-a',
      playbackGeneration: 1,
      leaderConnected: true,
      leaderFresh: true,
    });
  });

  test('a second participant cannot overwrite a healthy room timeline while the mic is free', () => {
    const songs = new SongSession();
    songs.update(telemetry({ currentTime: 10 }), A, null, 0);

    const rejected = songs.update(telemetry({ currentTime: 90 }), B, null, 250);
    assert.deepEqual(rejected, {
      accepted: false,
      reason: 'leader-busy',
      leaderChanged: false,
    });

    const status = songs.statusPayload(250) as Record<string, any>;
    assert.equal(status.playbackLeaderParticipantId, A.participantId);
    assert.ok(status.serverTime < 11, `unexpected overwritten serverTime ${status.serverTime}`);
  });

  test('another live tab from the same participant also cannot create last-writer-wins', () => {
    const songs = new SongSession();
    songs.update(telemetry(), A, null, 0);

    const rejected = songs.update(telemetry({ currentTime: 50 }), A_OTHER_TAB, null, 250);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'leader-busy');
    assert.equal((songs.statusPayload(250) as Record<string, any>).playbackTransportId, A.transportId);
  });

  test('a newer generation of the same transport replaces its previous page incarnation', () => {
    const songs = new SongSession();
    songs.update(telemetry(), A, null, 0);

    const replaced = songs.update(telemetry({ currentTime: 12 }), A_RELOAD, null, 250);
    assert.deepEqual(replaced, { accepted: true, leaderChanged: true });
    assert.equal((songs.statusPayload(250) as Record<string, any>).playbackGeneration, 2);

    const stale = songs.update(telemetry({ currentTime: 99 }), A, null, 300);
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, 'leader-busy');
  });

  test('disconnecting the leader lets another participant establish the room clock', () => {
    const songs = new SongSession();
    songs.update(telemetry(), A, null, 0);
    assert.equal(songs.detach(A), true);

    const next = songs.update(telemetry({ currentTime: 20 }), B, null, 100);
    assert.deepEqual(next, { accepted: true, leaderChanged: true });
    assert.equal((songs.statusPayload(100) as Record<string, any>).playbackLeaderParticipantId, B.participantId);
  });

  test('a stale leader can be replaced even if its socket never emitted close', () => {
    const songs = new SongSession();
    songs.update(telemetry(), A, null, 0);

    const next = songs.update(telemetry({ currentTime: 20 }), B, null, 1_501);
    assert.equal(next.accepted, true);
    assert.equal(next.leaderChanged, true);
    assert.equal((songs.statusPayload(1_501) as Record<string, any>).playbackLeaderParticipantId, B.participantId);
  });

  test('the microphone owner has authority over a previous participant leader', () => {
    const songs = new SongSession();
    songs.update(telemetry(), A, null, 0);

    const oldOwner = songs.update(telemetry({ currentTime: 11 }), A, B.participantId, 250);
    assert.deepEqual(oldOwner, {
      accepted: false,
      reason: 'mic-owner-required',
      leaderChanged: false,
    });

    const newOwner = songs.update(telemetry({ currentTime: 30 }), B, B.participantId, 300);
    assert.deepEqual(newOwner, { accepted: true, leaderChanged: true });
    assert.equal((songs.statusPayload(300) as Record<string, any>).playbackLeaderParticipantId, B.participantId);
  });

  test('a non-owner cannot claim an empty timeline while somebody holds the mic', () => {
    const songs = new SongSession();
    const result = songs.update(telemetry(), A, B.participantId, 0);

    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'mic-owner-required');
    assert.equal(songs.hasTelemetry, false);
  });

  test('malformed telemetry never claims playback authority', () => {
    const songs = new SongSession();
    const bad = songs.update(telemetry({ videoId: 'bad' }), A, null, 0);

    assert.deepEqual(bad, {
      accepted: false,
      reason: 'invalid-telemetry',
      leaderChanged: false,
    });
    assert.equal((songs.statusPayload(0) as Record<string, any>).playbackLeaderParticipantId, null);

    const good = songs.update(telemetry(), B, null, 1);
    assert.equal(good.accepted, true);
    assert.equal((songs.statusPayload(1) as Record<string, any>).playbackLeaderParticipantId, B.participantId);
  });
});
