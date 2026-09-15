import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MixFrameEvidence } from '../src/audio-session.js';
import { TakeController } from '../src/take-controller.js';
import type { TakeQualityFrameState } from '../src/take-quality.js';

const RATE = 48_000;
const FRAME_SAMPLES = 960;
const FRAME = Buffer.alloc(FRAME_SAMPLES * 2);
const QUALITY_STATE: TakeQualityFrameState = {
  timingMode: 'network-estimate',
  calibrationStale: false,
  alignmentClamped: false,
  robotRoute: false,
  robotDeltaFresh: true,
  timingDivergenceMs: null,
};
const FRAME_EVIDENCE: MixFrameEvidence = {
  micGapSamples: 0,
  backingGapSamples: 0,
  micStarvedSamples: 0,
  backingStarvedSamples: 0,
  micUnavailableSamples: 0,
  backingUnavailableSamples: 0,
  clippedSamples: 0,
  limitedSamples: 0,
  unheaderedSamples: 0,
};
const VOICE_ONLY_SONG = {
  videoId: null,
  revision: null,
  state: null,
  serverTime: null,
  playbackRate: null,
} as const;

test('accepted Stop closes Take quality events while buffered frames drain to the stop boundary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-stop-quality-window-'));
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

  try {
    const started = controller.start(
      'participant-a',
      VOICE_ONLY_SONG,
      { generation: 7, firstSampleIndex: 0 },
      1_000,
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;

    assert.equal(
      controller.append(
        FRAME,
        QUALITY_STATE,
        FRAME_EVIDENCE,
        { generation: 7, firstSampleIndex: 0 },
      ),
      true,
    );
    assert.equal(controller.noteQualityEvent('mic-capture-restarted'), true);

    const stopped = controller.stop(
      started.takeId,
      'participant-a',
      { generation: 7, firstSampleIndex: FRAME_SAMPLES * 2 },
      'user',
      2_000,
    );
    assert.equal(stopped.ok, true);
    assert.equal(controller.lifecycle, 'recording', 'buffered audio still drains after Stop is accepted');

    assert.equal(
      controller.noteQualityEvent('mic-transport-disconnected'),
      false,
      'a post-Stop wall-clock event must not contaminate the already-closed Take quality window',
    );

    assert.equal(
      controller.append(
        FRAME,
        QUALITY_STATE,
        FRAME_EVIDENCE,
        { generation: 7, firstSampleIndex: FRAME_SAMPLES },
      ),
      true,
      'frame evidence inside [Start, Stop) must still drain normally',
    );

    await ready;
    const entry = controller.historyEntry(started.takeId);
    assert.ok(entry?.quality);
    assert.equal(entry.quality.evidence.events['mic-capture-restarted'], 1);
    assert.equal(entry.quality.evidence.events['mic-transport-disconnected'], 0);
    const range = entry.mixSampleRange;
    assert.ok(range);
    assert.equal(range.sampleCount, FRAME_SAMPLES * 2);
  } finally {
    await controller.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
