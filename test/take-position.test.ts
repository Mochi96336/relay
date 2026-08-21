import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AudioSession,
  type MixFrameEvidence,
  type MixFramePosition,
} from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';
import { TakeController } from '../src/take-controller.js';
import type { TakeQualityFrameState } from '../src/take-quality.js';

const RATE = 48_000;
const FRAME_SAMPLES = 960;
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

function makeSession() {
  return new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 5_000,
  });
}

function pcm(value = 1_000, samples = FRAME_SAMPLES) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(value, i * 2);
  return buffer;
}

function positionedFrame(firstSampleIndex: number, value = 1_000): PcmFrame {
  return { generation: 1, firstSampleIndex, pcm: pcm(value) };
}

async function recordDrainedFrames(input: {
  session: AudioSession;
  controller: TakeController;
  nowMs: number;
  maxFrames: number;
}) {
  const positions: MixFramePosition[] = [];
  const evidence: MixFrameEvidence[] = [];
  const emitted = input.session.drain((frame, frameEvidence, position) => {
    positions.push({ ...position });
    evidence.push({ ...frameEvidence });
    assert.equal(
      input.controller.append(frame, QUALITY_STATE, frameEvidence, position),
      true,
      'every drained frame must cross the same recorder boundary with its position',
    );
  }, input.nowMs, input.maxFrames);
  return { emitted, positions, evidence };
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

test('Take persists the first and last authoritative output positions and mix generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-position-'));
  try {
    const session = makeSession();
    session.start(0);

    assert.equal(session.drain(() => {}, 20, 2), 2, 'advance the mix before recording starts');

    const { controller, ready } = waitForReady(directory);
    const started = controller.start('participant-a', VOICE_ONLY_SONG, 1_000);
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const drained = await recordDrainedFrames({
      session,
      controller,
      nowMs: 80,
      maxFrames: 3,
    });
    assert.equal(drained.emitted, 3);
    assert.deepEqual(drained.positions[0], {
      generation: session.generation,
      firstSampleIndex: FRAME_SAMPLES * 2,
    });
    assert.deepEqual(drained.positions.at(-1), {
      generation: session.generation,
      firstSampleIndex: FRAME_SAMPLES * 4,
    });

    assert.equal(controller.stop(started.takeId, 'participant-a', 'user', 1_100).ok, true);
    await ready;

    const entry = controller.historyEntry(started.takeId);
    assert.ok(entry);
    assert.deepEqual(entry.mixSampleRange, {
      generation: session.generation,
      startSampleIndex: FRAME_SAMPLES * 2,
      endSampleIndex: FRAME_SAMPLES * 5,
      sampleCount: FRAME_SAMPLES * 3,
    });
    assert.equal(entry.artifact.sampleCount, FRAME_SAMPLES * 3);
    assert.equal(
      entry.artifact.sampleCount,
      entry.mixSampleRange?.sampleCount,
      'finalized sidecar and actual WAV must agree on samples written',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a positioned capture packet gap does not compress the Take sample timeline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-position-gap-'));
  try {
    const session = makeSession();
    session.setMicExpected(true);
    session.setMicGainDb(0);
    session.start(0);
    session.ingestMic(positionedFrame(0), RATE, 0);
    session.ingestMic(positionedFrame(FRAME_SAMPLES * 2, 2_000), RATE, 0);

    const { controller, ready } = waitForReady(directory);
    const started = controller.start('participant-a', VOICE_ONLY_SONG, 1_000);
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const drained = await recordDrainedFrames({
      session,
      controller,
      nowMs: 40,
      maxFrames: 3,
    });
    assert.equal(drained.emitted, 3);
    assert.equal(drained.evidence[1].micGapSamples, FRAME_SAMPLES,
      'the middle output frame must describe the missing positioned capture packet');
    assert.deepEqual(
      drained.positions.map((position) => position.firstSampleIndex),
      [0, FRAME_SAMPLES, FRAME_SAMPLES * 2],
      'the authoritative mix clock continues across the source packet gap',
    );

    assert.equal(controller.stop(started.takeId, 'participant-a', 'user', 1_100).ok, true);
    await ready;

    const entry = controller.historyEntry(started.takeId);
    assert.ok(entry);
    assert.equal(entry.quality?.evidence.micGapSamples, FRAME_SAMPLES);
    assert.deepEqual(entry.mixSampleRange, {
      generation: session.generation,
      startSampleIndex: 0,
      endSampleIndex: FRAME_SAMPLES * 3,
      sampleCount: FRAME_SAMPLES * 3,
    });
    assert.equal(entry.artifact.sampleCount, FRAME_SAMPLES * 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
