import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';

const TAKE_ID = '88888888-8888-4888-8888-888888888888';

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

test('legacy WAV stays readable when recovered sidecar persistence fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-legacy-read-fallback-'));
  const endedAtMs = Date.now() - 5_000;
  try {
    const wavPath = path.join(directory, `${TAKE_ID}.wav`);
    await writeFile(wavPath, wav());
    await utimes(wavPath, new Date(endedAtMs), new Date(endedAtMs));

    const library = new TakeLibrary({ directory });
    Object.defineProperty(library, 'writeMetadata', {
      value: () => {
        const error = new Error('injected recovered-sidecar persistence failure') as NodeJS.ErrnoException;
        error.code = 'EROFS';
        throw error;
      },
    });

    // Startup recovery is allowed to fail to persist the repair. The WAV itself
    // remains valid read authority and must still be visible through both APIs.
    library.prepare();
    const entries = library.list();
    const direct = library.get(TAKE_ID);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].takeId, TAKE_ID);
    assert.equal(entries[0].recovered, true);
    assert.equal(entries[0].artifact.durationMs, 100);
    assert.ok(Math.abs(entries[0].endedAtMs - endedAtMs) < 10);
    assert.ok(direct);
    assert.equal(direct.takeId, TAKE_ID);
    assert.equal(direct.recovered, true);
    assert.equal((await readdir(directory)).includes(`${TAKE_ID}.json`), false,
      'read fallback must not pretend the failed sidecar repair became durable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
