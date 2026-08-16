import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WavTakeWriter, encodePcm16WavHeader } from '../src/wav-take-writer.js';

test('PCM16 WAV header describes one-channel 48 kHz audio', () => {
  const header = encodePcm16WavHeader(48_000, 1_920);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(4), 36 + 1_920);
  assert.equal(header.toString('ascii', 8, 12), 'WAVE');
  assert.equal(header.toString('ascii', 12, 16), 'fmt ');
  assert.equal(header.readUInt16LE(20), 1);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 48_000);
  assert.equal(header.readUInt32LE(28), 96_000);
  assert.equal(header.readUInt16LE(32), 2);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.toString('ascii', 36, 40), 'data');
  assert.equal(header.readUInt32LE(40), 1_920);
});

test('WavTakeWriter streams PCM into a hidden partial file and publishes only after finalization', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-writer-'));
  try {
    const writer = new WavTakeWriter({ directory, takeId: 'take-test', sampleRate: 48_000 });
    const first = Buffer.alloc(1_920);
    const second = Buffer.alloc(1_920);
    for (let i = 0; i < first.length / 2; i += 1) first.writeInt16LE(i % 32767, i * 2);
    for (let i = 0; i < second.length / 2; i += 1) second.writeInt16LE(-(i % 32767), i * 2);

    writer.append(first);
    writer.append(second);

    // The stable artifact name must not exist until RIFF lengths are patched.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const during = await readdir(directory);
    assert.equal(during.includes('take-test.wav'), false);
    assert.equal(during.includes('take-test.wav.part'), true);

    const artifact = await writer.finalize();
    assert.equal(artifact.fileName, 'take-test.wav');
    assert.equal(artifact.sampleRate, 48_000);
    assert.equal(artifact.channels, 1);
    assert.equal(artifact.bitsPerSample, 16);
    assert.equal(artifact.sampleCount, 1_920);
    assert.equal(artifact.durationMs, 40);

    const wav = await readFile(artifact.filePath);
    assert.equal(wav.byteLength, 44 + first.byteLength + second.byteLength);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), first.byteLength + second.byteLength);
    assert.deepEqual(wav.subarray(44, 44 + first.byteLength), first);
    assert.deepEqual(wav.subarray(44 + first.byteLength), second);

    const after = await readdir(directory);
    assert.equal(after.includes('take-test.wav'), true);
    assert.equal(after.includes('take-test.wav.part'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('WavTakeWriter fails explicitly instead of buffering an unbounded disk queue', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-backpressure-'));
  const writer = new WavTakeWriter({
    directory,
    takeId: 'take-backpressure',
    sampleRate: 48_000,
    maxPendingBytes: 1_000,
  });
  try {
    assert.throws(
      () => writer.append(Buffer.alloc(1_920)),
      /could not keep up with the authoritative mix/,
    );
    assert.equal(writer.sampleCount, 0, 'rejected PCM must not be counted as recorded audio');
  } finally {
    await writer.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await readdir(directory), []);
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborting a Take removes its partial artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-abort-'));
  try {
    const writer = new WavTakeWriter({ directory, takeId: 'take-abort', sampleRate: 48_000 });
    writer.append(Buffer.alloc(1_920));
    await writer.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
