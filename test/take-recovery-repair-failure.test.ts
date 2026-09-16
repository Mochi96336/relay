import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';

const FINAL_ID = '99999999-9999-4999-8999-999999999991';
const STAGED_ID = '99999999-9999-4999-8999-999999999992';
const ORPHAN_ID = '99999999-9999-4999-8999-999999999993';
const SAMPLE_RATE = 48_000;
const SAMPLE_COUNT = 4_800;

function wav(sampleRate = SAMPLE_RATE, sampleCount = SAMPLE_COUNT) {
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

function take(takeId: string, lifecycle: 'ready' | 'finalizing'): TakeRecord {
  const bytes = wav();
  return {
    takeId,
    lifecycle,
    startedAtMs: 1_000,
    endedAtMs: 1_100,
    startedByParticipantId: 'participant-a',
    stoppedByParticipantId: 'participant-a',
    stopReason: 'user',
    song: {
      videoId: 'video-a',
      revision: 3,
      state: 1,
      serverTime: 12,
      playbackRate: 1,
    },
    artifact: lifecycle === 'ready' ? {
      fileName: `${takeId}.wav`,
      url: `/takes/${takeId}.wav`,
      mimeType: 'audio/wav',
      sizeBytes: bytes.byteLength,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: SAMPLE_COUNT,
      durationMs: 100,
    } : null,
    mixSampleRange: {
      generation: 1,
      startSampleIndex: 0,
      endSampleIndex: SAMPLE_COUNT,
      sampleCount: SAMPLE_COUNT,
    },
    quality: null,
    error: null,
  };
}

test('valid final metadata stays authoritative when stale partial cleanup fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-repair-final-'));
  try {
    await writeFile(path.join(directory, `${FINAL_ID}.wav`), wav());
    new TakeLibrary({ directory }).record(take(FINAL_ID, 'ready'));

    // A directory at the stale-part path deterministically makes non-recursive
    // rmSync fail without relying on chmod/root behavior.
    await mkdir(path.join(directory, `${FINAL_ID}.json.part`));

    const entries = new TakeLibrary({ directory }).list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].takeId, FINAL_ID);
    assert.equal(entries[0].recovered, false,
      'failed stale-part cleanup must not revoke already-valid committed metadata');
    assert.equal(entries[0].startedByParticipantId, 'participant-a');
    assert.equal(entries[0].song?.videoId, 'video-a');
    assert.equal((await stat(path.join(directory, `${FINAL_ID}.json`))).isFile(), true,
      'valid final metadata must remain in place');
    assert.equal((await stat(path.join(directory, `${FINAL_ID}.json.part`))).isDirectory(), true,
      'failed maintenance cleanup may remain pending without hiding the Take');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('valid staged metadata remains readable when cleanup and promotion cannot complete', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-repair-staged-'));
  try {
    const stagingLibrary = new TakeLibrary({ directory });
    stagingLibrary.stageFinalizing(take(STAGED_ID, 'finalizing'), {
      sampleRate: SAMPLE_RATE,
      sampleCount: SAMPLE_COUNT,
    });
    await writeFile(path.join(directory, `${STAGED_ID}.wav`), wav());

    // Simulate an unremovable invalid final-sidecar path. Recovery cannot delete
    // it and therefore cannot rename the valid transaction candidate over it.
    await mkdir(path.join(directory, `${STAGED_ID}.json`));

    const entries = new TakeLibrary({ directory }).list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].takeId, STAGED_ID);
    assert.equal(entries[0].recovered, false,
      'a fully validated staged transaction retains its rich metadata as read authority');
    assert.equal(entries[0].startedByParticipantId, 'participant-a');
    assert.equal(entries[0].song?.videoId, 'video-a');
    assert.deepEqual(entries[0].mixSampleRange, {
      generation: 1,
      startSampleIndex: 0,
      endSampleIndex: SAMPLE_COUNT,
      sampleCount: SAMPLE_COUNT,
    });
    assert.equal((await stat(path.join(directory, `${STAGED_ID}.json.part`))).isFile(), true,
      'failed promotion must leave the staged transaction available for a later retry');
    assert.equal((await stat(path.join(directory, `${STAGED_ID}.json`))).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unremovable orphan metadata partial does not make the library unavailable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-repair-orphan-'));
  try {
    const orphanPath = path.join(directory, `${ORPHAN_ID}.json.part`);
    await mkdir(orphanPath);

    const library = new TakeLibrary({ directory });
    assert.doesNotThrow(() => library.prepare());
    assert.deepEqual(library.list(), []);
    assert.equal((await stat(orphanPath)).isDirectory(), true,
      'failed orphan cleanup is maintenance debt, not a reason to fail reads');
    assert.deepEqual(await readdir(directory), [`${ORPHAN_ID}.json.part`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
