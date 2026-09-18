import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';

const TAKE_ID = '77777777-7777-4777-8777-777777777777';
const SAMPLE_RATE = 44_100;
const SAMPLE_COUNT = 1_001;
const EXPECTED_DURATION_MS = (SAMPLE_COUNT / SAMPLE_RATE) * 1000;

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

function readyTake(url = `/takes/${TAKE_ID}.wav`): TakeRecord {
  return {
    takeId: TAKE_ID,
    lifecycle: 'ready',
    startedAtMs: 1_000,
    endedAtMs: 1_000 + EXPECTED_DURATION_MS,
    startedByParticipantId: 'participant-a',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    song: {
      videoId: 'video-artifact-authority',
      revision: 3,
      state: 1,
      serverTime: 42,
      playbackRate: 1,
    },
    artifact: {
      fileName: `${TAKE_ID}.wav`,
      url,
      mimeType: 'audio/wav',
      sizeBytes: wav().byteLength,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: SAMPLE_COUNT,
      durationMs: EXPECTED_DURATION_MS,
    },
    mixSampleRange: {
      generation: 2,
      startSampleIndex: 20_000,
      endSampleIndex: 20_000 + SAMPLE_COUNT,
      sampleCount: SAMPLE_COUNT,
    },
    quality: null,
    error: null,
  };
}

function finalizingTake(): TakeRecord {
  const take = readyTake();
  return {
    ...take,
    lifecycle: 'finalizing',
    artifact: null,
  };
}

test('runtime history derives URL and duration from the validated WAV, not persisted sidecar claims', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-artifact-authority-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const writer = new TakeLibrary({ directory });
    writer.record(readyTake());

    const metadataPath = path.join(directory, `${TAKE_ID}.json`);
    const payload = JSON.parse(await readFile(metadataPath, 'utf8'));
    payload.take.artifact.url = 'https://invalid.example/not-this-take.wav';
    payload.take.artifact.durationMs = 999_999;
    await writeFile(metadataPath, `${JSON.stringify(payload)}\n`);
    const persistedBytes = await readFile(metadataPath);

    const restarted = new TakeLibrary({ directory, artifactBaseUrl: '/current-takes/' });
    restarted.prepare();
    const entry = restarted.get(TAKE_ID);
    const listed = restarted.list()[0];

    assert.ok(entry);
    assert.ok(listed);
    assert.equal(entry.recovered, false, 'valid rich metadata must not be discarded just because derived artifact claims are stale');
    assert.equal(entry.song?.videoId, 'video-artifact-authority');
    assert.equal(entry.artifact.url, `/current-takes/${TAKE_ID}.wav`);
    assert.equal(entry.artifact.durationMs, EXPECTED_DURATION_MS);
    assert.equal(listed.artifact.url, entry.artifact.url);
    assert.equal(listed.artifact.durationMs, EXPECTED_DURATION_MS);
    assert.deepEqual(
      await readFile(metadataPath),
      persistedBytes,
      'runtime artifact derivation must not rewrite archival sidecar bytes',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('WAV-only recovery persists the same fractional duration formula as the live writer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-artifact-duration-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const library = new TakeLibrary({ directory });
    library.prepare();

    const entry = library.get(TAKE_ID);
    assert.ok(entry);
    assert.equal(entry.recovered, true);
    assert.equal(entry.artifact.durationMs, EXPECTED_DURATION_MS);
    assert.notEqual(entry.artifact.durationMs, Math.round(EXPECTED_DURATION_MS));

    const payload = JSON.parse(await readFile(path.join(directory, `${TAKE_ID}.json`), 'utf8'));
    assert.equal(payload.take.artifact.durationMs, EXPECTED_DURATION_MS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('staged byte-identity commit stays separate from runtime artifact normalization', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-artifact-staged-'));
  try {
    const library = new TakeLibrary({ directory, artifactBaseUrl: '/media/' });
    const staged = library.stageFinalizing(finalizingTake(), {
      sampleRate: SAMPLE_RATE,
      sampleCount: SAMPLE_COUNT,
    });
    assert.equal(staged.artifact?.url, `/media//${TAKE_ID}.wav`);

    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const committed = library.commitStaged(readyTake(`/media//${TAKE_ID}.wav`));
    assert.equal(committed.artifact.url, `/media//${TAKE_ID}.wav`);

    const restarted = new TakeLibrary({ directory, artifactBaseUrl: '/media/' });
    const runtime = restarted.get(TAKE_ID);
    assert.ok(runtime);
    assert.equal(runtime.artifact.url, `/media/${TAKE_ID}.wav`);
    assert.equal(runtime.artifact.durationMs, EXPECTED_DURATION_MS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
