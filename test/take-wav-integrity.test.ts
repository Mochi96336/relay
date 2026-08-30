import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';

const TAKE_ID = '66666666-6666-4666-8666-666666666666';

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

async function assertRejectedArtifact(bytes: Buffer, label: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-wav-integrity-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), bytes);
    const library = new TakeLibrary({ directory });
    library.prepare();

    assert.deepEqual(library.list(), [], label);
    assert.equal(library.get(TAKE_ID), null, label);
    assert.equal(
      (await readdir(directory)).includes(`${TAKE_ID}.json`),
      false,
      'invalid WAV must not be legitimized by recovered metadata',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('TakeLibrary accepts an exact canonical Relay WAV', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-wav-valid-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const library = new TakeLibrary({ directory });
    library.prepare();
    const entry = library.get(TAKE_ID);

    assert.ok(entry);
    assert.equal(entry.recovered, true);
    assert.equal(entry.artifact.sampleCount, 4_800);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TakeLibrary rejects a WAV truncated below the declared data length', async () => {
  const bytes = wav();
  await assertRejectedArtifact(
    bytes.subarray(0, bytes.byteLength - 200),
    'truncated finalized WAV must fail closed',
  );
});

test('TakeLibrary rejects trailing bytes outside the declared WAV payload', async () => {
  await assertRejectedArtifact(
    Buffer.concat([wav(), Buffer.alloc(2)]),
    'unexpected trailing bytes must fail closed',
  );
});

test('TakeLibrary rejects odd-length PCM even when RIFF and file lengths agree', async () => {
  const canonical = wav();
  const odd = Buffer.from(canonical.subarray(0, canonical.byteLength - 1));
  const dataBytes = odd.byteLength - 44;
  odd.writeUInt32LE(36 + dataBytes, 4);
  odd.writeUInt32LE(dataBytes, 40);

  await assertRejectedArtifact(odd, '16-bit PCM must contain complete samples');
});

test('TakeLibrary rejects inconsistent canonical PCM rate/alignment fields', async () => {
  const badByteRate = wav();
  badByteRate.writeUInt32LE(48_000, 28);
  await assertRejectedArtifact(badByteRate, 'byte rate mismatch must fail closed');

  const badBlockAlign = wav();
  badBlockAlign.writeUInt16LE(1, 32);
  await assertRejectedArtifact(badBlockAlign, 'block alignment mismatch must fail closed');
});
