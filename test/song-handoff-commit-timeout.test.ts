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

test('a live target that never proves commit rolls back to preparation without replacing the old leader', () => {
  const songs = new SongSession();
  songs.update(telemetry(10), A, A.participantId, 0);

  const plan = songs.beginHandoff(B, B.participantId, 100);
  assert.ok(plan);
  assert.ok(songs.markHandoffReady(B, plan.handoffId, B.participantId, 150));
  assert.equal((songs.statusPayload(150) as Record<string, any>).handoffState, 'committing');

  // The target is still alive, so this must not cancel the handoff. It only
  // closes the short proof window and requires a fresh ready acknowledgement.
  assert.equal(songs.sweepHandoff(true, 5_149), false);
  assert.equal((songs.statusPayload(5_149) as Record<string, any>).handoffState, 'committing');

  assert.equal(songs.sweepHandoff(true, 5_151), false);
  const rolledBack = songs.statusPayload(5_151) as Record<string, any>;
  assert.equal(rolledBack.handoffState, 'preparing');
  assert.equal(rolledBack.playbackLeaderParticipantId, A.participantId);
  assert.equal(rolledBack.playbackTransportId, A.transportId);

  // Once the proof window has closed, stale target telemetry cannot quietly
  // complete the old commit. The target must cross the ready boundary again.
  const staleTarget = songs.update(telemetry(15), B, B.participantId, 5_200);
  assert.equal(staleTarget.accepted, false);
  assert.equal(staleTarget.reason, 'handoff-not-ready');

  const retry = songs.markHandoffReady(B, plan.handoffId, B.participantId, 5_250);
  assert.ok(retry);
  const completed = songs.update(telemetry(10.4), B, B.participantId, 5_300);
  assert.equal(completed.accepted, true);
  assert.equal(completed.handoffCompleted, true);
  assert.equal((songs.statusPayload(5_300) as Record<string, any>).playbackLeaderParticipantId, B.participantId);
});
