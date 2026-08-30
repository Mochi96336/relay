import assert from 'node:assert/strict';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';
import { prepareTakeStorage, type TakeStoragePolicy } from '../src/take-storage.js';

const TAKE_ID = '55555555-5555-4555-8555-555555555555';
const policy: TakeStoragePolicy = { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 };

function wav(sampleRate = 48_000, sampleCount = 4_800) {
  const dataBytes = sampleCount * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
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
      videoId: 'video-a',
      revision: 4,
      state: 1,
      serverTime: 12.5,
      playbackRate: 1,
    },
    artifact: {
      fileName: `${TAKE_ID}.wav`,
      url: `/takes/${TAKE_ID}.wav`,
      mimeType: 'audio/wav',
      sizeBytes: bytes.byteLength,
      sampleRate: 48_000,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: 4_800,
      durationMs: 100,
    },
    mixSampleRange: {
      generation: 7,
      startSampleIndex: 9_600,
      endSampleIndex: 14_400,
      sampleCount: 4_800,
    },
    quality: null,
    error: null,
  };
}

test('startup promotes a complete metadata partial beside its finalized WAV', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-partial-promote-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const library = new TakeLibrary({ directory });
    library.record(readyTake());
    await rename(
      path.join(directory, `${TAKE_ID}.json`),
      path.join(directory, `${TAKE_ID}.json.part`),
    );

    const prepared = prepareTakeStorage(directory, policy);
    assert.equal(prepared.removedPartialFiles, 0, 'recoverable metadata transaction must survive storage preparation');

    const restarted = new TakeLibrary({ directory });
    restarted.prepare();
    const entry = restarted.get(TAKE_ID);

    assert.ok(entry);
    assert.equal(entry.recovered, false);
    assert.equal(entry.startedByParticipantId, 'participant-a');
    assert.equal(entry.stoppedByParticipantId, 'participant-b');
    assert.equal(entry.stopReason, 'user');
    assert.equal(entry.song?.videoId, 'video-a');
    assert.deepEqual(entry.mixSampleRange, readyTake().mixSampleRange);
    assert.equal(entry.quality, null);
    const names = await readdir(directory);
    assert.equal(names.includes(`${TAKE_ID}.json`), true);
    assert.equal(names.includes(`${TAKE_ID}.json.part`), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid metadata partial fails closed to WAV-only recovery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-partial-invalid-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    await writeFile(path.join(directory, `${TAKE_ID}.json.part`), '{not-json');

    prepareTakeStorage(directory, policy);
    const library = new TakeLibrary({ directory });
    library.prepare();
    const entry = library.get(TAKE_ID);

    assert.ok(entry);
    assert.equal(entry.recovered, true);
    assert.equal(entry.startedByParticipantId, null);
    assert.equal(entry.song, null);
    assert.equal(entry.mixSampleRange, null);
    const names = await readdir(directory);
    assert.equal(names.includes(`${TAKE_ID}.json.part`), false);
    assert.equal(names.includes(`${TAKE_ID}.json`), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('storage preparation removes orphan metadata partials with no finalized WAV', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-partial-orphan-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.json.part`), '{}');
    const prepared = prepareTakeStorage(directory, policy);

    assert.equal(prepared.removedPartialFiles, 1);
    assert.equal((await readdir(directory)).includes(`${TAKE_ID}.json.part`), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
