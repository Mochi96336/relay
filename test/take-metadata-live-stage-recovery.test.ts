import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';

const TAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAMPLE_RATE = 48_000;
const SAMPLE_COUNT = 4_800;

function wav() {
  const dataBytes = SAMPLE_COUNT * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

function readyTake(): TakeRecord {
  const bytes = wav();
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
    library.stageFinalizing(finalizingTake(), {
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

    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const committed = library.commitStaged(readyTake());

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

test('a fresh TakeLibrary instance still removes a pre-WAV metadata partial as a crash orphan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-restart-orphan-'));
  try {
    const liveLibrary = new TakeLibrary({ directory });
    liveLibrary.stageFinalizing(finalizingTake(), {
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
