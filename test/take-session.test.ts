import assert from 'node:assert/strict';
import test from 'node:test';

import { TakeSession, type TakeArtifact, type TakeSongSnapshot } from '../src/take-session.js';

const SONG: TakeSongSnapshot = {
  videoId: 'dQw4w9WgXcQ',
  revision: 12,
  state: 1,
  serverTime: 42.5,
  playbackRate: 1,
};

const ARTIFACT: TakeArtifact = {
  fileName: 'take-1.wav',
  url: '/takes/take-1.wav',
  mimeType: 'audio/wav',
  sizeBytes: 96_044,
  sampleRate: 48_000,
  channels: 1,
  bitsPerSample: 16,
  sampleCount: 48_000,
  durationMs: 1_000,
};

test('TakeSession owns one room recording lifecycle without owning the microphone', () => {
  const takes = new TakeSession();
  assert.equal(takes.lifecycle, 'idle');

  const started = takes.start({
    takeId: 'take-1',
    startedByParticipantId: 'participant-a',
    song: SONG,
    startedAtMs: 1_000,
  });
  assert.equal(started.ok, true);
  assert.equal(takes.lifecycle, 'recording');
  assert.equal(takes.recordingTakeId, 'take-1');

  // A different participant may be holding the Mic by the time the room stops
  // the Take. The Take remains the same room-owned recording.
  const stopped = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    endedAtMs: 2_000,
  });
  assert.equal(stopped.ok, true);
  if (!stopped.ok) return;
  assert.equal(stopped.duplicate, false);
  assert.equal(stopped.take.startedByParticipantId, 'participant-a');
  assert.equal(stopped.take.stoppedByParticipantId, 'participant-b');
  assert.equal(stopped.take.takeId, 'take-1');
  assert.equal(stopped.take.lifecycle, 'finalizing');

  assert.equal(takes.complete('take-1', ARTIFACT), true);
  assert.equal(takes.lifecycle, 'ready');
  assert.deepEqual(takes.currentTake()?.artifact, ARTIFACT);
});

test('TakeSession prevents stale Stop from touching a newer Take', () => {
  const takes = new TakeSession();
  takes.start({ takeId: 'take-1', startedByParticipantId: 'participant-a', song: SONG, startedAtMs: 1_000 });
  takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-a',
    stopReason: 'user',
    endedAtMs: 2_000,
  });
  takes.complete('take-1', ARTIFACT);

  const second = takes.start({
    takeId: 'take-2',
    startedByParticipantId: 'participant-b',
    song: { ...SONG, revision: 13 },
    startedAtMs: 3_000,
  });
  assert.equal(second.ok, true);

  assert.deepEqual(
    takes.beginFinalizing({
      takeId: 'take-1',
      stoppedByParticipantId: 'participant-a',
      stopReason: 'user',
      endedAtMs: 3_100,
    }),
    { ok: false, reason: 'stale-take' },
  );
  assert.equal(takes.recordingTakeId, 'take-2');
});

test('TakeSession makes repeated Stop idempotent during and after finalization', () => {
  const takes = new TakeSession();
  takes.start({ takeId: 'take-1', startedByParticipantId: 'participant-a', song: SONG, startedAtMs: 1_000 });

  const first = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-a',
    stopReason: 'user',
    endedAtMs: 2_000,
  });
  assert.equal(first.ok && first.duplicate, false);

  const second = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    endedAtMs: 2_100,
  });
  assert.equal(second.ok && second.duplicate, true);
  assert.equal(takes.currentTake()?.stoppedByParticipantId, 'participant-a');

  takes.complete('take-1', ARTIFACT);
  const afterReady = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    endedAtMs: 2_200,
  });
  assert.equal(afterReady.ok && afterReady.duplicate, true);
  assert.equal(takes.lifecycle, 'ready');
});

test('TakeSession exposes writer failure as a terminal failed Take', () => {
  const takes = new TakeSession();
  takes.start({ takeId: 'take-1', startedByParticipantId: 'participant-a', song: SONG, startedAtMs: 1_000 });
  assert.equal(takes.fail('take-1', 'disk full', 1_500), true);
  assert.equal(takes.lifecycle, 'failed');
  assert.equal(takes.currentTake()?.error, 'disk full');
  assert.equal(takes.currentTake()?.endedAtMs, 1_500);
});
