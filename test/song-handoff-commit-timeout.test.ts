import assert from 'node:assert/strict';
import test from 'node:test';

import { SongSession } from '../src/song-session.js';

const VIDEO = 'dQw4w9WgXcQ';
const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 1 };

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

test('a live target that never proves commit is cancelled without replacing the old leader', () => {
  const songs = new SongSession();
  songs.update(telemetry(10), A, A.participantId, 0);

  const plan = songs.beginHandoff(B, B.participantId, 100);
  assert.ok(plan);
  assert.ok(songs.markHandoffReady(B, plan.handoffId, B.participantId, 150));
  assert.equal((songs.statusPayload(150) as Record<string, any>).handoffState, 'committing');

  assert.equal(songs.sweepHandoff(true, 5_149), false);
  assert.equal((songs.statusPayload(5_149) as Record<string, any>).handoffState, 'committing');

  assert.equal(songs.sweepHandoff(true, 5_151), true,
    'the server watchdog must make an externally visible cancellation, not a silent rollback');
  const cancelled = songs.statusPayload(5_151) as Record<string, any>;
  assert.equal(cancelled.handoffState, 'idle');
  assert.equal(cancelled.playbackLeaderParticipantId, A.participantId);
  assert.equal(cancelled.playbackTransportId, A.transportId);

  // Mic ownership already moved to B, but a failed playback transfer must not
  // make A's existing media clock disappear. A may keep the same song moving as
  // holdover until another explicit recovery succeeds.
  const holdover = songs.update(telemetry(15.2), A, B.participantId, 5_200);
  assert.deepEqual(holdover, { accepted: true, leaderChanged: false });

  const semanticChange = songs.update(
    telemetry(15.25, { state: 2 }), A, B.participantId, 5_250,
  );
  assert.equal(semanticChange.accepted, false);
  assert.equal(semanticChange.reason, 'handoff-holdover-semantic-change');
});
