import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import { TakeQualityTracker } from '../src/take-quality.js';
import type { TakeRecord } from '../src/take-session.js';

const TAKE_ID = '88888888-8888-4888-8888-888888888888';
const SAMPLE_RATE = 48_000;
const SAMPLE_COUNT = 4_800;
const QUALITY = new TakeQualityTracker({
  sampleRate: SAMPLE_RATE,
  backingExpected: false,
  timingExpected: false,
}).assessment();

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
  return {
    takeId: TAKE_ID,
    lifecycle: 'ready',
    startedAtMs: 1_000,
    endedAtMs: 1_100,
    startedByParticipantId: 'participant-a',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    song: {
      videoId: 'video-rich-evidence',
      revision: 9,
      state: 1,
      serverTime: 24.5,
      playbackRate: 1,
    },
    artifact: {
      fileName: `${TAKE_ID}.wav`,
      url: `/takes/${TAKE_ID}.wav`,
      mimeType: 'audio/wav',
      sizeBytes: wav().byteLength,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: SAMPLE_COUNT,
      durationMs: 100,
    },
    mixSampleRange: {
      generation: 3,
      startSampleIndex: 10_000,
      endSampleIndex: 14_800,
      sampleCount: SAMPLE_COUNT,
    },
    quality: structuredClone(QUALITY),
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

function assertRichEvidence(entry: ReturnType<TakeLibrary['get']>) {
  assert.ok(entry);
  assert.equal(entry.recovered, false);
  assert.equal(entry.startedByParticipantId, 'participant-a');
  assert.equal(entry.stoppedByParticipantId, 'participant-b');
  assert.equal(entry.stopReason, 'user');
  assert.equal(entry.song?.videoId, 'video-rich-evidence');
  assert.deepEqual(entry.mixSampleRange, readyTake().mixSampleRange);
  assert.deepEqual(entry.quality, readyTake().quality);
  assert.equal(entry.artifact.url, `/takes/${TAKE_ID}.wav`);
  assert.equal(entry.artifact.durationMs, 100);
}

test('invalid derived artifact claims do not discard valid finalized rich metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-derived-final-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const library = new TakeLibrary({ directory });
    library.record(readyTake());

    const metadataPath = path.join(directory, `${TAKE_ID}.json`);
    const payload = JSON.parse(await readFile(metadataPath, 'utf8'));
    payload.take.artifact.url = { corrupted: true };
    delete payload.take.artifact.durationMs;
    await writeFile(metadataPath, `${JSON.stringify(payload)}\n`);
    const persistedBytes = await readFile(metadataPath);

    const restarted = new TakeLibrary({ directory });
    restarted.prepare();
    assertRichEvidence(restarted.get(TAKE_ID));
    assert.deepEqual(
      await readFile(metadataPath),
      persistedBytes,
      'derived-claim damage must not rewrite or downgrade otherwise valid rich metadata',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('crash recovery promotes rich metadata partials even when only derived artifact claims are damaged', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-derived-partial-'));
  try {
    const library = new TakeLibrary({ directory });
    library.stageFinalizing(finalizingTake(), {
      sampleRate: SAMPLE_RATE,
      sampleCount: SAMPLE_COUNT,
    });

    const partialPath = path.join(directory, `${TAKE_ID}.json.part`);
    const payload = JSON.parse(await readFile(partialPath, 'utf8'));
    payload.take.artifact.url = ['not', 'authoritative'];
    payload.take.artifact.durationMs = { stale: true };
    await writeFile(partialPath, `${JSON.stringify(payload)}\n`);
    const partialBytes = await readFile(partialPath);

    // Simulate the #273 crash window: WAV publication succeeded but the process
    // died before the staged metadata candidate could be renamed.
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());

    const restarted = new TakeLibrary({ directory });
    restarted.prepare();
    assertRichEvidence(restarted.get(TAKE_ID));

    const names = await readdir(directory);
    assert.equal(names.includes(`${TAKE_ID}.json.part`), false);
    assert.equal(names.includes(`${TAKE_ID}.json`), true);
    assert.deepEqual(
      await readFile(path.join(directory, `${TAKE_ID}.json`)),
      partialBytes,
      'promotion must remain a rename of the fsynced candidate, not a repair rewrite',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
