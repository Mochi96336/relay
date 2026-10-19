import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';
import { wav } from './support/take-wav.js';

const TAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAMPLE_RATE = 48_000;
const SAMPLE_COUNT = 4_800;

function readyTake(): TakeRecord {
  const bytes = wav(SAMPLE_RATE, SAMPLE_COUNT);
  return {
    takeId: TAKE_ID,
    lifecycle: 'ready',
    startedAtMs: 1_000,
    endedAtMs: 1_100,
    startedByParticipantId: 'participant-a',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    song: {
      videoId: 'video-live-stage',
      revision: 3,
      state: 1,
      serverTime: 15,
      playbackRate: 1,
    },
    artifact: {
      fileName: `${TAKE_ID}.wav`,
      url: `/takes/${TAKE_ID}.wav`,
      mimeType: 'audio/wav',
      sizeBytes: bytes.byteLength,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: SAMPLE_COUNT,
      durationMs: 100,
    },
    mixSampleRange: {
      generation: 8,
      startSampleIndex: 48_000,
      endSampleIndex: 52_800,
      sampleCount: SAMPLE_COUNT,
    },
    quality: null,
    error: null,
  };
}

function finalizingTake(): TakeRecord {
  return {
    ...readyTake(),
    lifecycle: 'finalizing',
    artifact: null,
  };
}

test('same-process history reads preserve rich metadata staged before WAV publication', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-live-stage-'));
  try {
    const library = new TakeLibrary({ directory });
    await library.stageFinalizing(finalizingTake(), {
      sampleRate: SAMPLE_RATE,
      sampleCount: SAMPLE_COUNT,
    });

    assert.equal((await readdir(directory)).includes(`${TAKE_ID}.json.part`), true);
    assert.deepEqual(library.list(), []);
    assert.equal(library.get(TAKE_ID), null);
    assert.equal(
      (await readdir(directory)).includes(`${TAKE_ID}.json.part`),
      true,
      'live staged metadata must survive readers before the WAV is published',
    );

    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav(SAMPLE_RATE, SAMPLE_COUNT));
    const committed = await library.commitStaged(readyTake());

    assert.equal(committed.recovered, false);
    assert.equal(committed.startedByParticipantId, 'participant-a');
    assert.equal(committed.song?.videoId, 'video-live-stage');
    const names = await readdir(directory);
    assert.equal(names.includes(`${TAKE_ID}.json`), true);
    assert.equal(names.includes(`${TAKE_ID}.json.part`), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a history repair that promotes the stage while its commit is in flight does not fail the commit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-live-stage-race-'));
  try {
    const library = new TakeLibrary({ directory });
    const staging = library.stageFinalizing(finalizingTake(), {
      sampleRate: SAMPLE_RATE,
      sampleCount: SAMPLE_COUNT,
    });
    // A history read while the stage is still being written must not take the
    // partial for an orphan.
    assert.deepEqual(library.list(), []);
    await staging;

    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav(SAMPLE_RATE, SAMPLE_COUNT));
    const commit = library.commitStaged(readyTake());
    // The commit is now waiting on the disk; a synchronous repair promotes the
    // same stage in the meantime.
    assert.equal(library.get(TAKE_ID)?.startedByParticipantId, 'participant-a');
    const committed = await commit;

    assert.equal(committed.recovered, false);
    assert.equal(committed.song?.videoId, 'video-live-stage');
    const names = await readdir(directory);
    assert.equal(names.includes(`${TAKE_ID}.json`), true);
    assert.equal(names.includes(`${TAKE_ID}.json.part`), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a fresh TakeLibrary instance still removes a pre-WAV metadata partial as a crash orphan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-restart-orphan-'));
  try {
    const liveLibrary = new TakeLibrary({ directory });
    await liveLibrary.stageFinalizing(finalizingTake(), {
      sampleRate: SAMPLE_RATE,
      sampleCount: SAMPLE_COUNT,
    });
    assert.equal((await readdir(directory)).includes(`${TAKE_ID}.json.part`), true);

    const restarted = new TakeLibrary({ directory });
    restarted.prepare();

    assert.equal((await readdir(directory)).includes(`${TAKE_ID}.json.part`), false);
    assert.equal(restarted.get(TAKE_ID), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
