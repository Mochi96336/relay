import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';

const COMMITTED = '11111111-1111-4111-8111-111111111111';
const LEGACY = '22222222-2222-4222-8222-222222222222';
const BROKEN_SIDECAR = '33333333-3333-4333-8333-333333333333';
const STAGED = '44444444-4444-4444-8444-444444444444';
const MISMATCHED = '55555555-5555-4555-8555-555555555555';
const CORRUPT_WAV = '66666666-6666-4666-8666-666666666666';
const ORPHAN_SIDECAR = '77777777-7777-4777-8777-777777777777';

function wav(sampleCount = 4_800) {
  const dataBytes = sampleCount * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48_000, 24);
  bytes.writeUInt32LE(96_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

function readyTake(takeId: string, endedAtMs: number): TakeRecord {
  return {
    takeId,
    lifecycle: 'ready',
    startedAtMs: endedAtMs - 100,
    endedAtMs,
    startedByParticipantId: 'participant-a',
    stoppedByParticipantId: 'participant-a',
    stopReason: 'user',
    song: { videoId: 'video-a', revision: 1, state: 1, serverTime: 12, playbackRate: 1 },
    artifact: {
      fileName: `${takeId}.wav`,
      url: `/takes/${takeId}.wav`,
      mimeType: 'audio/wav',
      sizeBytes: wav().byteLength,
      sampleRate: 48_000,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: 4_800,
      durationMs: 100,
    },
    mixSampleRange: { generation: 1, startSampleIndex: 0, endSampleIndex: 4_800, sampleCount: 4_800 },
    quality: null,
    error: null,
  };
}

async function snapshot(directory: string) {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => [name, (await readFile(path.join(directory, name))).toString('base64')]));
}

test('listAsync reads the history list() returns, and repairs nothing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-list-async-'));
  try {
    const library = new TakeLibrary({ directory });
    const file = (name: string) => path.join(directory, name);

    await writeFile(file(`${COMMITTED}.wav`), wav());
    library.record(readyTake(COMMITTED, 5_000_000));

    const legacyAt = new Date(4_000_000);
    await writeFile(file(`${LEGACY}.wav`), wav());
    await utimes(file(`${LEGACY}.wav`), legacyAt, legacyAt);

    await writeFile(file(`${BROKEN_SIDECAR}.wav`), wav());
    await writeFile(file(`${BROKEN_SIDECAR}.json`), '{ not json');
    await utimes(file(`${BROKEN_SIDECAR}.wav`), new Date(3_000_000), new Date(3_000_000));

    // A complete staged transaction whose promotion never happened.
    await writeFile(file(`${STAGED}.wav`), wav());
    library.record(readyTake(STAGED, 6_000_000));
    await rename(file(`${STAGED}.json`), file(`${STAGED}.json.part`));

    // Its sidecar describes a different recording than the WAV now holds.
    await writeFile(file(`${MISMATCHED}.wav`), wav());
    library.record(readyTake(MISMATCHED, 7_000_000));
    await writeFile(file(`${MISMATCHED}.wav`), wav(2_400));
    await utimes(file(`${MISMATCHED}.wav`), new Date(2_000_000), new Date(2_000_000));

    await writeFile(file(`${CORRUPT_WAV}.wav`), Buffer.from('not a wav at all'));
    await writeFile(file(`${ORPHAN_SIDECAR}.json`), JSON.stringify({ version: 1, take: {} }));

    const before = await snapshot(directory);
    const asynchronous = await library.listAsync();
    assert.deepEqual(await snapshot(directory), before, 'listAsync must not write or remove anything');

    const synchronous = library.list();
    assert.deepEqual(asynchronous, synchronous);
    // Recovered: rebuilt from the WAV alone, as list()'s repair rebuilds it.
    assert.deepEqual(
      new Map(asynchronous.map((entry) => [entry.takeId, entry.recovered])),
      new Map([
        [COMMITTED, false],
        [STAGED, false],
        [LEGACY, true],
        [BROKEN_SIDECAR, true],
        [MISMATCHED, true],
      ]),
      'the corrupt WAV and the orphan sidecar are left out',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('listAsync of an empty or missing directory is an empty history', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'relay-take-list-async-empty-'));
  try {
    const library = new TakeLibrary({ directory: path.join(parent, 'takes') });
    assert.deepEqual(await library.listAsync(), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
