import assert from 'node:assert/strict';
import test from 'node:test';

import { assessTakeQuality, type TakeQualityEvidence } from '../src/take-quality.js';
import { TakeSession, type TakeArtifact, type TakeSongSnapshot } from '../src/take-session.js';

const RATE = 48_000;

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
  sampleRate: RATE,
  channels: 1,
  bitsPerSample: 16,
  sampleCount: RATE,
  durationMs: 1_000,
};

function position(firstSampleIndex = 0, generation = 1) {
  return { generation, firstSampleIndex };
}

function cleanQuality() {
  const evidence: TakeQualityEvidence = {
    sampleRate: RATE,
    recordedSamples: RATE,
    recordedDurationMs: 1_000,
    micGapSamples: 0,
    micGapMs: 0,
    backingGapSamples: 0,
    backingGapMs: 0,
    micStarvedFrames: 0,
    backingStarvedFrames: 0,
    micStarvedSamples: 0,
    backingStarvedSamples: 0,
    micStarvedMs: 0,
    backingStarvedMs: 0,
    clippedSamples: 0,
    clippedMs: 0,
    limitedSamples: 0,
    limitedMs: 0,
    unheaderedSamples: 0,
    unheadered: false,
    micUnavailableSamples: 0,
    micUnavailableMs: 0,
    backingUnavailableSamples: 0,
    backingUnavailableMs: 0,
    networkEstimateSamples: 0,
    networkEstimateMs: 0,
    calibrationStaleSamples: 0,
    calibrationStaleMs: 0,
    alignmentClampedSamples: 0,
    alignmentClampedMs: 0,
    robotDeltaMissingSamples: 0,
    robotDeltaMissingMs: 0,
    events: {
      'mic-transport-disconnected': 0,
      'mic-transport-connected': 0,
      'mic-capture-restarted': 0,
      'backing-transport-disconnected': 0,
      'backing-transport-connected': 0,
      'backing-transport-replaced': 0,
      'backing-capture-restarted': 0,
      'robot-source-disconnected': 0,
      'robot-source-connected': 0,
      'robot-source-replaced': 0,
      'mic-owner-changed': 0,
    },
  };
  return assessTakeQuality(evidence);
}

test('TakeSession owns one room recording lifecycle without owning the microphone', () => {
  const takes = new TakeSession();
  assert.equal(takes.lifecycle, 'idle');

  const started = takes.start({
    takeId: 'take-1',
    startedByParticipantId: 'participant-a',
    song: SONG,
    startPosition: position(9_600),
    startedAtMs: 1_000,
  });
  assert.equal(started.ok, true);
  assert.equal(takes.lifecycle, 'recording');
  assert.equal(takes.recordingTakeId, 'take-1');
  assert.deepEqual(takes.currentTake()?.mixSampleRange, {
    generation: 1,
    startSampleIndex: 9_600,
    endSampleIndex: 9_600,
    sampleCount: 0,
  });

  // A different participant may be holding the Mic by the time the room stops
  // the Take. The Take remains the same room-owned recording.
  const quality = cleanQuality();
  const stopped = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    stopPosition: position(9_600),
    endedAtMs: 2_000,
    quality,
  });
  assert.equal(stopped.ok, true);
  if (!stopped.ok) return;
  assert.equal(stopped.duplicate, false);
  assert.equal(stopped.take.startedByParticipantId, 'participant-a');
  assert.equal(stopped.take.stoppedByParticipantId, 'participant-b');
  assert.equal(stopped.take.takeId, 'take-1');
  assert.equal(stopped.take.lifecycle, 'finalizing');
  assert.deepEqual(stopped.take.quality, quality);

  assert.equal(takes.complete('take-1', ARTIFACT), true);
  assert.equal(takes.lifecycle, 'ready');
  assert.deepEqual(takes.currentTake()?.artifact, ARTIFACT);
  assert.deepEqual(takes.currentTake()?.quality, quality);
});

test('TakeSession preserves explicit Start and exclusive Stop positions around accepted frames', () => {
  const takes = new TakeSession();
  takes.start({
    takeId: 'take-1',
    startedByParticipantId: 'participant-a',
    song: SONG,
    startPosition: position(9_600, 4),
    startedAtMs: 1_000,
  });

  assert.equal(takes.appendMixFrame(position(9_600, 4), 960), true);
  assert.equal(takes.appendMixFrame(position(10_560, 4), 960), true);
  const stopped = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-a',
    stopReason: 'user',
    stopPosition: position(11_520, 4),
    endedAtMs: 2_000,
    quality: cleanQuality(),
  });
  assert.equal(stopped.ok, true);
  if (!stopped.ok) return;
  assert.deepEqual(stopped.take.mixSampleRange, {
    generation: 4,
    startSampleIndex: 9_600,
    endSampleIndex: 11_520,
    sampleCount: 1_920,
  });
});

test('TakeSession prevents stale Stop from touching a newer Take', () => {
  const takes = new TakeSession();
  takes.start({
    takeId: 'take-1',
    startedByParticipantId: 'participant-a',
    song: SONG,
    startPosition: position(),
    startedAtMs: 1_000,
  });
  takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-a',
    stopReason: 'user',
    stopPosition: position(),
    endedAtMs: 2_000,
    quality: cleanQuality(),
  });
  takes.complete('take-1', ARTIFACT);

  const second = takes.start({
    takeId: 'take-2',
    startedByParticipantId: 'participant-b',
    song: { ...SONG, revision: 13 },
    startPosition: position(96_000, 2),
    startedAtMs: 3_000,
  });
  assert.equal(second.ok, true);

  assert.deepEqual(
    takes.beginFinalizing({
      takeId: 'take-1',
      stoppedByParticipantId: 'participant-a',
      stopReason: 'user',
      stopPosition: position(96_000, 2),
      endedAtMs: 3_100,
      quality: cleanQuality(),
    }),
    { ok: false, reason: 'stale-take' },
  );
  assert.equal(takes.recordingTakeId, 'take-2');
});

test('TakeSession makes repeated Stop idempotent during and after finalization', () => {
  const takes = new TakeSession();
  takes.start({
    takeId: 'take-1',
    startedByParticipantId: 'participant-a',
    song: SONG,
    startPosition: position(),
    startedAtMs: 1_000,
  });

  const firstQuality = cleanQuality();
  const first = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-a',
    stopReason: 'user',
    stopPosition: position(),
    endedAtMs: 2_000,
    quality: firstQuality,
  });
  assert.equal(first.ok && first.duplicate, false);

  const second = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    stopPosition: position(),
    endedAtMs: 2_100,
    quality: assessTakeQuality({
      ...firstQuality.evidence,
      micUnavailableSamples: 24_000,
      micUnavailableMs: 500,
    }),
  });
  assert.equal(second.ok && second.duplicate, true);
  assert.equal(takes.currentTake()?.stoppedByParticipantId, 'participant-a');
  assert.deepEqual(takes.currentTake()?.quality, firstQuality);

  takes.complete('take-1', ARTIFACT);
  const afterReady = takes.beginFinalizing({
    takeId: 'take-1',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    stopPosition: position(),
    endedAtMs: 2_200,
    quality: cleanQuality(),
  });
  assert.equal(afterReady.ok && afterReady.duplicate, true);
  assert.equal(takes.lifecycle, 'ready');
});

test('TakeSession exposes writer failure as a terminal failed Take', () => {
  const takes = new TakeSession();
  takes.start({
    takeId: 'take-1',
    startedByParticipantId: 'participant-a',
    song: SONG,
    startPosition: position(),
    startedAtMs: 1_000,
  });
  const quality = cleanQuality();
  assert.equal(takes.fail('take-1', 'disk full', 1_500, quality), true);
  assert.equal(takes.lifecycle, 'failed');
  assert.equal(takes.currentTake()?.error, 'disk full');
  assert.equal(takes.currentTake()?.endedAtMs, 1_500);
  assert.deepEqual(takes.currentTake()?.quality, quality);
});
