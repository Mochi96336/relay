import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { takeFrameBoundaryAtOrAfter } from '../src/take-boundary.js';
import { TakeController } from '../src/take-controller.js';
import type { TakeQualityFrameState } from '../src/take-quality.js';
import { takeSongSnapshotFromRoom } from '../src/take-song-snapshot.js';
import { YouTubeTimelineTracker } from '../src/youtube-timeline.js';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = 960;
const PREBUFFER_MS = 400;
const QUALITY_STATE: TakeQualityFrameState = {
  timingMode: 'network-estimate',
  calibrationStale: false,
  alignmentClamped: false,
  robotRoute: false,
  robotDeltaFresh: true,
};
const VOICE_ONLY_SONG = {
  videoId: null,
  revision: null,
  state: null,
  serverTime: null,
  playbackRate: null,
} as const;

function boundaryFor(session: AudioSession, nowMs: number) {
  return takeFrameBoundaryAtOrAfter({
    generation: session.generation,
    sessionSampleIndex: session.sessionSampleAt(nowMs),
    frameSamples: session.frameSamples,
    sampleRate: session.sampleRate,
    nowMs,
  });
}

function waitForReady(directory: string) {
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const controller = new TakeController({
    directory,
    sampleRate: RATE,
    storagePolicy: { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 },
    onStorageError: (error) => { throw error; },
    onChange: (status) => {
      if (status.lifecycle === 'ready') resolveReady?.();
    },
  });
  return { controller, ready };
}

test('prebuffer does not move the WAV Start boundary before the Start command', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-prebuffer-boundary-'));
  try {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      prebufferMs: PREBUFFER_MS,
      backingGain: 1,
      retentionMs: 5_000,
    });
    session.start(0);

    const startCommandAtMs = 405;
    const startBoundary = boundaryFor(session, startCommandAtMs);
    assert.deepEqual(startBoundary.position, {
      generation: session.generation,
      firstSampleIndex: FRAME_SAMPLES * 21,
    });
    assert.equal(startBoundary.atMs, 420);
    assert.ok(
      startBoundary.atMs - startCommandAtMs >= 0
      && startBoundary.atMs - startCommandAtMs < FRAME_MS,
      'full-frame quantization may move Start forward by less than one frame only',
    );

    const { controller, ready } = waitForReady(directory);
    const started = controller.start(
      'participant-a',
      VOICE_ONLY_SONG,
      startBoundary.position,
      1_000 + (startBoundary.atMs - startCommandAtMs),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const immediatePositions: number[] = [];
    session.drain((frame, evidence, position) => {
      immediatePositions.push(position.firstSampleIndex);
      assert.equal(controller.append(frame, QUALITY_STATE, evidence, position), false);
    }, startCommandAtMs, 10);
    assert.deepEqual(immediatePositions, [0],
      'the frame available at command time is still the prebuffered past and must not enter the WAV');

    const stopCommandAtMs = 421;
    const stopBoundary = boundaryFor(session, stopCommandAtMs);
    assert.deepEqual(stopBoundary.position, {
      generation: session.generation,
      firstSampleIndex: FRAME_SAMPLES * 22,
    });
    assert.equal(
      controller.stop(
        started.takeId,
        'participant-a',
        stopBoundary.position,
        'user',
        2_000 + (stopBoundary.atMs - stopCommandAtMs),
      ).ok,
      true,
    );

    const acceptedPositions: number[] = [];
    session.drain((frame, evidence, position) => {
      if (controller.append(frame, QUALITY_STATE, evidence, position)) {
        acceptedPositions.push(position.firstSampleIndex);
      }
    }, 860, 100);

    assert.deepEqual(acceptedPositions, [startBoundary.position.firstSampleIndex],
      'only the one complete frame inside [Start, Stop) is recorded');
    await ready;

    const entry = controller.historyEntry(started.takeId);
    assert.ok(entry);
    assert.deepEqual(entry.mixSampleRange, {
      generation: session.generation,
      startSampleIndex: startBoundary.position.firstSampleIndex,
      endSampleIndex: stopBoundary.position.firstSampleIndex,
      sampleCount: FRAME_SAMPLES,
    });
    assert.equal(entry.artifact.sampleCount, FRAME_SAMPLES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Song snapshot is projected at the exact first-audio frame coordinate', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: PREBUFFER_MS,
    backingGain: 1,
    retentionMs: 5_000,
  });
  session.start(0);

  const commandAtMs = 405;
  const boundary = boundaryFor(session, commandAtMs);
  assert.equal(boundary.atMs, 420);

  const timeline = new YouTubeTimelineTracker();
  assert.equal(timeline.update({
    videoId: 'dQw4w9WgXcQ',
    videoTitle: 'Example',
    videoAuthor: 'Relay',
    currentTime: 12,
    duration: 180,
    state: 1,
    playbackRate: 1,
    bufferedFraction: 1,
    networkRttMs: 0,
  }, 400), true);

  const roomAtFirstAudio = {
    ...timeline.statusPayload(boundary.atMs),
    revision: 17,
  } as Record<string, unknown>;
  const snapshot = takeSongSnapshotFromRoom(roomAtFirstAudio);

  assert.equal(snapshot.videoId, 'dQw4w9WgXcQ');
  assert.equal(snapshot.revision, 17);
  assert.equal(snapshot.state, 1);
  assert.equal(snapshot.playbackRate, 1);
  assert.ok(snapshot.serverTime !== null);
  assert.ok(Math.abs(snapshot.serverTime - 12.02) < 1e-9,
    'Song time must describe the 420 ms mix-frame start, not the 405 ms command instant');
});
