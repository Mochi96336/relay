import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { SongSession } from '../src/song-session.js';

const VIDEO = 'dQw4w9WgXcQ';
const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 1 };
const B_OTHER = { participantId: 'participant-b', transportId: 'playback-tab-b-other', generation: 1 };
const C = { participantId: 'participant-c', transportId: 'playback-tab-c', generation: 1 };

function telemetry(currentTime: number, overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    ...overrides,
  };
}

describe('prepared song handoff', () => {
  test('a handoff whose target vanishes does not hold the room song for ever', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, null, 0);
    assert.ok(songs.beginHandoff(B, B.participantId, 100));

    assert.equal(songs.update(telemetry(60), A, B.participantId, 200).accepted, false);
    assert.equal(songs.update(telemetry(60), B_OTHER, B.participantId, 200).reason, 'handoff-not-target');

    assert.equal(songs.sweepHandoff(true, 200), false, 'a present target is still waited for');
    assert.equal(songs.sweepHandoff(false, 200), true, 'a departed target ends the handoff');
    assert.equal(songs.statusPayload(200).handoffState, 'idle');

    assert.equal(songs.update(telemetry(60), A, null, 300).accepted, true);
  });

  test('a target that never answers the plan cannot hold the room past the prepare deadline', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, null, 0);
    assert.ok(songs.beginHandoff(B, B.participantId, 100));

    assert.equal(songs.sweepHandoff(true, 100 + 19_000), false, 'still inside the preparation deadline');
    assert.equal(songs.sweepHandoff(true, 100 + 21_000), true, 'an unanswered plan expires');
    assert.equal(songs.statusPayload(0).handoffState, 'idle');
  });

  test('an acknowledged target may retry briefly but cannot hold the room forever', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, null, 0);
    const plan = songs.beginHandoff(B, B.participantId, 100);
    assert.ok(plan);
    assert.ok(songs.markHandoffReady(B, plan.handoffId, B.participantId, 150));
    assert.equal(songs.deferHandoff(B, plan.handoffId), true);

    assert.equal(
      songs.sweepHandoff(true, 100 + 29_000),
      false,
      'a short autoplay/user-gesture retry stays inside the total deadline',
    );
    assert.equal(
      songs.sweepHandoff(true, 100 + 31_000),
      true,
      'ready once is not a permanent exemption from handoff expiry',
    );
    assert.equal((songs.statusPayload(100 + 31_000) as Record<string, any>).handoffState, 'idle');
  });

  test('does not create a handoff merely because another playback transport exists', () => {
    const songs = new SongSession();

    assert.equal(songs.beginHandoff(B, B.participantId, 0), null, 'there is no room song to hand off');
    assert.deepEqual(songs.roomStatusPayload(0), {
      type: 'room-song-status',
      revision: 0,
      connected: false,
      videoId: null,
      state: null,
      serverTime: null,
      duration: null,
      playbackRate: null,
      handoffState: 'idle',
      handoffTargetParticipantId: null,
    });
  });

  test('prepares only the current Mic owner as the target', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);

    assert.equal(songs.beginHandoff(B, C.participantId, 100), null);
    assert.equal((songs.statusPayload(100) as Record<string, any>).handoffState, 'idle');

    const plan = songs.beginHandoff(B, B.participantId, 100);
    assert.ok(plan);
    assert.equal(plan.target.participantId, B.participantId);
    assert.equal(plan.videoId, VIDEO);
    assert.equal(plan.state, 1);
    assert.ok(plan.serverTime > 10);
    assert.equal((songs.roomStatusPayload(100) as Record<string, any>).handoffState, 'preparing');
  });

  test('keeps the old playback clock alive while the new owner is preparing', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const plan = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(plan);

    const holdover = songs.update(telemetry(10.25), A, B.participantId, 250);
    assert.deepEqual(holdover, { accepted: true, leaderChanged: false });

    const status = songs.statusPayload(250) as Record<string, any>;
    assert.equal(status.playbackLeaderParticipantId, A.participantId);
    assert.equal(status.leaderFresh, true);
    assert.equal(status.handoffState, 'preparing');
  });

  test('does not let the old singer change room song intent during handoff', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    songs.beginHandoff(B, B.participantId, 250);

    const paused = songs.update(telemetry(10.25, { state: 2 }), A, B.participantId, 250);
    assert.equal(paused.accepted, false);
    assert.equal(paused.reason, 'handoff-holdover-semantic-change');

    const seeked = songs.update(telemetry(60), A, B.participantId, 300);
    assert.equal(seeked.accepted, false);
    assert.equal(seeked.reason, 'handoff-holdover-semantic-change');

    const status = songs.statusPayload(300) as Record<string, any>;
    assert.equal(status.state, 1);
    assert.ok(status.serverTime < 11, `old singer overwrote room time: ${status.serverTime}`);
  });

  test('locks a pending handoff to the exact target transport, not merely the Mic owner', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const plan = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(plan);

    const siblingTab = songs.update(telemetry(10.3), B_OTHER, B.participantId, 300);
    assert.equal(siblingTab.accepted, false);
    assert.equal(siblingTab.reason, 'handoff-not-target');
    assert.equal((songs.statusPayload(300) as Record<string, any>).playbackLeaderParticipantId, A.participantId);
  });

  test('target cannot take the clock before the server receives a ready acknowledgement', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const plan = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(plan);

    const early = songs.update(telemetry(10.3), B, B.participantId, 300);
    assert.equal(early.accepted, false);
    assert.equal(early.reason, 'handoff-not-ready');
    assert.equal((songs.statusPayload(300) as Record<string, any>).playbackLeaderParticipantId, A.participantId);
  });

  /**
   * The old deadlock was real: a buffering target was refused against a moving
   * room serverTime and therefore never got a report accepted that could give a
   * later proof a sensible target-local reference. Accept BUFFERING into a
   * candidate-only clock instead. That preserves convergence evidence without
   * publishing the target as room truth before it can actually play.
   */
  test('buffering target telemetry converges privately but cannot complete the handoff', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const prepared = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(prepared);
    assert.ok(songs.markHandoffReady(B, prepared.handoffId, B.participantId, 300));

    const buffering = songs.update(
      telemetry(9.6, { state: 3 }), B, B.participantId, 1_600,
    );
    assert.deepEqual(buffering, { accepted: true, leaderChanged: false });

    const waiting = songs.statusPayload(1_600) as Record<string, any>;
    assert.equal(waiting.handoffState, 'committing');
    assert.equal(waiting.playbackLeaderParticipantId, A.participantId);
    assert.equal(waiting.state, 1, 'candidate BUFFERING must not overwrite authoritative room state');

    const completed = songs.update(
      telemetry(9.9, { state: 1 }), B, B.participantId, 1_800,
    );
    assert.equal(completed.accepted, true);
    assert.equal(completed.handoffCompleted, true);
    assert.equal((songs.statusPayload(1_800) as Record<string, any>).playbackLeaderParticipantId, B.participantId);
  });

  test('a real jump by the target is still refused', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const prepared = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(prepared);
    assert.ok(songs.markHandoffReady(B, prepared.handoffId, B.participantId, 300));

    const jumped = songs.update(telemetry(90, { state: 3 }), B, B.participantId, 350);
    assert.equal(jumped.accepted, false);
    assert.equal(jumped.reason, 'handoff-song-mismatch');

    const other = songs.update(
      telemetry(10.2, { videoId: 'kJQP7kiw5Fk' }), B, B.participantId, 350,
    );
    assert.equal(other.accepted, false);
  });

  test('target proof must preserve the room playback rate', () => {
    const songs = new SongSession();
    songs.update(telemetry(10, { playbackRate: 1.25 }), A, A.participantId, 0);
    const prepared = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(prepared);
    assert.ok(songs.markHandoffReady(B, prepared.handoffId, B.participantId, 300));

    const wrongRate = songs.update(
      telemetry(10.3, { playbackRate: 1 }), B, B.participantId, 350,
    );
    assert.equal(wrongRate.accepted, false);
    assert.equal(wrongRate.reason, 'handoff-song-mismatch');
    assert.equal((songs.statusPayload(350) as Record<string, any>).playbackLeaderParticipantId, A.participantId);
  });

  test('ready plus matching target telemetry commits atomically and releases the handoff', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const prepared = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(prepared);

    const commit = songs.markHandoffReady(B, prepared.handoffId, B.participantId, 300);
    assert.ok(commit);
    assert.equal((songs.statusPayload(300) as Record<string, any>).handoffState, 'committing');

    const completed = songs.update(telemetry(10.35), B, B.participantId, 350);
    assert.deepEqual(completed, {
      accepted: true,
      leaderChanged: true,
      handoffCompleted: true,
      handoffId: prepared.handoffId,
      previousLeader: A,
    });

    const status = songs.statusPayload(350) as Record<string, any>;
    assert.equal(status.playbackLeaderParticipantId, B.participantId);
    assert.equal(status.playbackTransportId, B.transportId);
    assert.equal(status.handoffState, 'idle');
    assert.equal((songs.roomStatusPayload(350) as Record<string, any>).handoffState, 'idle');
  });

  test('a ready target still cannot commit a different song or a distant timeline', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const prepared = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(prepared);
    assert.ok(songs.markHandoffReady(B, prepared.handoffId, B.participantId, 300));

    const otherVideo = songs.update(
      telemetry(10.35, { videoId: '9bZkp7q19f0' }),
      B,
      B.participantId,
      350,
    );
    assert.equal(otherVideo.accepted, false);
    assert.equal(otherVideo.reason, 'handoff-song-mismatch');

    const distant = songs.update(telemetry(90), B, B.participantId, 400);
    assert.equal(distant.accepted, false);
    assert.equal(distant.reason, 'handoff-song-mismatch');
    assert.equal((songs.statusPayload(400) as Record<string, any>).playbackLeaderParticipantId, A.participantId);
  });

  test('a client-reported failed commit returns to preparation without dropping the old leader', () => {
    const songs = new SongSession();
    songs.update(telemetry(10), A, A.participantId, 0);
    const prepared = songs.beginHandoff(B, B.participantId, 250);
    assert.ok(prepared);
    assert.ok(songs.markHandoffReady(B, prepared.handoffId, B.participantId, 300));

    assert.equal(songs.deferHandoff(B, prepared.handoffId), true);
    const status = songs.statusPayload(320) as Record<string, any>;
    assert.equal(status.handoffState, 'preparing');
    assert.equal(status.playbackLeaderParticipantId, A.participantId);
  });
});
