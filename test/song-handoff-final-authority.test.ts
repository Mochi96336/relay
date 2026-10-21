import assert from 'node:assert/strict';
import test from 'node:test';

import { SongSession } from '../src/song-session.js';
import { telemetry } from './support/song-handoff-telemetry.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 1 };
const B_RELOADED = { ...B, generation: 2 };

test('reloading the prepared target cannot mint a fresh whole-handoff deadline', () => {
  const songs = new SongSession();
  songs.update(telemetry(10), A, A.participantId, 0);

  const first = songs.beginHandoff(B, B.participantId, 100);
  assert.ok(first);

  const replayed = songs.handoffPlanForTarget(B_RELOADED, 19_000);
  assert.ok(replayed);
  assert.notEqual(replayed.handoffId, first.handoffId, 'a new generation gets a new handoff identity');
  assert.equal(replayed.target.generation, 2);

  // Isolate the whole-handoff ceiling from the separate 20 s never-ready
  // deadline: the reloaded generation really does answer, then explicitly
  // defers its commit retry while remaining inside the original lifecycle.
  assert.ok(songs.markHandoffReady(B_RELOADED, replayed.handoffId, B.participantId, 19_100));
  assert.equal(songs.deferHandoff(B_RELOADED, replayed.handoffId), true);

  assert.equal(
    songs.sweepHandoff(true, 30_000, B.participantId),
    false,
    '29.9 s after the original handoff birth is still inside the hard ceiling',
  );
  assert.equal(
    songs.sweepHandoff(true, 30_101, B.participantId),
    true,
    'the replacement generation expires immediately after the original 30 s lifetime',
  );
  assert.equal((songs.statusPayload(30_101) as Record<string, unknown>).handoffState, 'idle');
});

test('a target that resumes behind after BUFFERING cannot rewind the authoritative room clock', () => {
  const songs = new SongSession();
  songs.update(telemetry(10), A, A.participantId, 0);

  const plan = songs.beginHandoff(B, B.participantId, 100);
  assert.ok(plan);
  assert.ok(songs.markHandoffReady(B, plan.handoffId, B.participantId, 150));

  const buffering = songs.update(
    telemetry(10.1, { state: 3 }),
    B,
    B.participantId,
    500,
  );
  assert.deepEqual(buffering, { accepted: true, leaderChanged: false });

  // A keeps the real room clock moving while B is stalled.
  const holdover = songs.update(telemetry(14), A, B.participantId, 4_000);
  assert.equal(holdover.accepted, true);

  // B is self-consistent with its frozen BUFFERING candidate, but several
  // seconds behind the authoritative old leader. That is not final proof.
  const stale = songs.update(telemetry(10.2), B, B.participantId, 4_100);
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'handoff-song-mismatch');
  assert.equal(
    (songs.statusPayload(4_100) as Record<string, unknown>).playbackLeaderParticipantId,
    A.participantId,
  );

  // Once the target explicitly realigns to the live room position, the jump
  // relative to its frozen candidate is intentional and may complete safely.
  const aligned = songs.update(telemetry(14.1), B, B.participantId, 4_120);
  assert.equal(aligned.accepted, true);
  assert.equal(aligned.handoffCompleted, true);

  const status = songs.statusPayload(4_120) as Record<string, unknown>;
  assert.equal(status.playbackLeaderParticipantId, B.participantId);
  assert.ok(Number(status.serverTime) >= 14, 'promotion must not rewind room time to the stale candidate');
});

for (const phase of ['preparing', 'committing']) {
  test(`a song ending during ${phase} refreshes the target without extending its deadline`, () => {
    const songs = new SongSession();
    songs.update(telemetry(199.5, { state: 1 }), A, null, 0);
    const plan = songs.beginHandoff(B, B.participantId, 0)!;
    if (phase === 'committing') songs.markHandoffReady(B, plan.handoffId, B.participantId, 10);
    assert.equal(songs.update(telemetry(200, { state: 0 }), A, B.participantId, 500).accepted, true);
    const refreshed = songs.refreshHandoff(500)!;
    assert.equal(refreshed.phase, phase);
    assert.equal(refreshed.plan.handoffId, plan.handoffId);
    assert.equal(refreshed.plan.state, 5);
    assert.equal(refreshed.plan.serverTime, 0);
    assert.equal(songs.refreshHandoff(501), null);
    if (phase === 'committing') assert.equal(songs.handoffSweepReason(true, 5011), 'commit-timeout');
    else songs.markHandoffReady(B, plan.handoffId, B.participantId, 550);
    const completed = songs.update(telemetry(0, { state: 5, bufferedFraction: 0 }), B, B.participantId, 600);
    assert.equal(completed.handoffCompleted, true);
    assert.equal(songs.statusPayload(600).state, 0);
    assert.equal(songs.statusPayload(600).serverTime, 200);
  });
}

test('holdover distinguishes transport buffering, natural completion and unauthorized input', () => {
  const songs = new SongSession();
  songs.update(telemetry(10), A, null, 0);
  songs.beginHandoff(B, B.participantId, 0);
  assert.equal(songs.update(telemetry(10.1, { state: 3 }), A, B.participantId, 100).accepted, true);
  assert.equal(songs.update(telemetry(10.2, { state: 1 }), A, B.participantId, 200).accepted, true);
  assert.equal(songs.update(telemetry(10.3, { state: 0 }), A, B.participantId, 300).accepted, false);
  assert.equal(songs.update(telemetry(10.3, { state: 2 }), A, B.participantId, 300).accepted, false);
  assert.equal(songs.refreshHandoff(300), null);
  const paused = new SongSession();
  paused.update(telemetry(10, { state: 2 }), A, null, 0);
  paused.beginHandoff(B, B.participantId, 0);
  assert.equal(paused.update(telemetry(10.1, { state: 3 }), A, B.participantId, 100).accepted, false);
  assert.equal(paused.refreshHandoff(100), null);
});
