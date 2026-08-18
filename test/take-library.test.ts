import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';

const TAKE_1 = '11111111-1111-4111-8111-111111111111';
const TAKE_2 = '22222222-2222-4222-8222-222222222222';

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

test('TakeLibrary recovers a legacy WAV into durable metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-library-legacy-'));
  const endedAtMs = Date.now() - 5_000;
  try {
    const wavPath = path.join(directory, `${TAKE_1}.wav`);
    await writeFile(wavPath, wav());
    await utimes(wavPath, new Date(endedAtMs), new Date(endedAtMs));

    const library = new TakeLibrary({ directory });
    library.prepare();
    const entries = library.list();

    assert.equal(entries.length, 1);
    assert.equal(entries[0].takeId, TAKE_1);
    assert.equal(entries[0].recovered, true);
    assert.equal(entries[0].song, null);
    assert.equal(entries[0].startedByParticipantId, null);
    assert.equal(entries[0].artifact.durationMs, 100);
    assert.equal(entries[0].artifact.url, `/takes/${TAKE_1}.wav`);
    assert.ok(Math.abs(entries[0].endedAtMs - endedAtMs) < 10);
    assert.ok((await readdir(directory)).includes(`${TAKE_1}.json`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TakeLibrary preserves finalized Take metadata across a new instance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-library-persist-'));
  try {
    await writeFile(path.join(directory, `${TAKE_2}.wav`), wav());
    const take: TakeRecord = {
      takeId: TAKE_2,
      lifecycle: 'ready',
      startedAtMs: 1_000,
      endedAtMs: 1_100,
      startedByParticipantId: 'participant-a',
      stoppedByParticipantId: 'participant-b',
      stopReason: 'user',
      song: {
        videoId: 'video-a',
        revision: 3,
        state: 1,
        serverTime: 12,
        playbackRate: 1,
      },
      artifact: {
        fileName: `${TAKE_2}.wav`,
        url: `/takes/${TAKE_2}.wav`,
        mimeType: 'audio/wav',
        sizeBytes: wav().byteLength,
        sampleRate: 48_000,
        channels: 1,
        bitsPerSample: 16,
        sampleCount: 4_800,
        durationMs: 100,
      },
      quality: null,
      error: null,
    };

    new TakeLibrary({ directory }).record(take);
    const entry = new TakeLibrary({ directory }).get(TAKE_2);

    assert.ok(entry);
    assert.equal(entry.recovered, false);
    assert.equal(entry.startedByParticipantId, 'participant-a');
    assert.equal(entry.stoppedByParticipantId, 'participant-b');
    assert.equal(entry.song?.videoId, 'video-a');
    const sidecar = JSON.parse(await readFile(path.join(directory, `${TAKE_2}.json`), 'utf8'));
    assert.equal(sidecar.version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
