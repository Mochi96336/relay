import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import type { TakeRecord } from '../src/take-session.js';

const TAKE_ID = '99999999-9999-4999-8999-999999999999';
const SAMPLE_RATE = 48_000;
const SAMPLE_COUNT = 4_800;
const MAX_JS_DATE_MS = 8_640_000_000_000_000;

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
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_000_100,
    startedByParticipantId: 'participant-a',
    stoppedByParticipantId: 'participant-b',
    stopReason: 'user',
    song: {
      videoId: 'video-wall-clock',
      revision: 1,
      state: 1,
      serverTime: 10,
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
      generation: 1,
      startSampleIndex: 0,
      endSampleIndex: SAMPLE_COUNT,
      sampleCount: SAMPLE_COUNT,
    },
    quality: null,
    error: null,
  };
}

async function recoverWithTimestampMutation(
  mutate: (take: Record<string, unknown>) => void,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-wall-clock-'));
  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());
    const writer = new TakeLibrary({ directory });
    writer.record(readyTake());

    const metadataPath = path.join(directory, `${TAKE_ID}.json`);
    const payload = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      take: Record<string, unknown>;
    };
    mutate(payload.take);
    await writeFile(metadataPath, `${JSON.stringify(payload)}\n`);

    const restarted = new TakeLibrary({ directory });
    restarted.prepare();
    const entry = restarted.get(TAKE_ID);
    assert.ok(entry);
    return { entry };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('persisted wall-clock timestamps outside the JavaScript Date domain fail closed to WAV recovery', async (t) => {
  await t.test('endedAtMs beyond TimeClip range cannot poison product history formatting', async () => {
    const { entry } = await recoverWithTimestampMutation((take) => {
      take.endedAtMs = MAX_JS_DATE_MS + 1;
    });

    assert.equal(entry.recovered, true);
    assert.equal(entry.song, null);
    assert.equal(entry.startedByParticipantId, null);
    assert.ok(entry.endedAtMs >= 0 && entry.endedAtMs <= MAX_JS_DATE_MS);
    assert.doesNotThrow(() => {
      new Intl.DateTimeFormat('en-US').format(new Date(entry.endedAtMs));
    });
  });

  await t.test('negative startedAtMs is not accepted as persisted wall-clock evidence', async () => {
    const { entry } = await recoverWithTimestampMutation((take) => {
      take.startedAtMs = -1;
    });

    assert.equal(entry.recovered, true);
    assert.equal(entry.song, null);
    assert.equal(entry.startedByParticipantId, null);
    assert.ok(entry.startedAtMs >= 0);
  });
});

test('WAV-only recovery clamps a pre-epoch filesystem mtime into the persisted wall-clock domain', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-wall-clock-mtime-'));
  try {
    const wavPath = path.join(directory, `${TAKE_ID}.wav`);
    await writeFile(wavPath, wav());
    await utimes(wavPath, new Date(-1_000), new Date(-1_000));
    assert.ok((await stat(wavPath)).mtimeMs < 0, 'fixture must expose a pre-epoch filesystem mtime');

    const library = new TakeLibrary({ directory });
    library.prepare();
    const first = library.get(TAKE_ID);
    assert.ok(first);
    assert.equal(first.recovered, true);
    assert.equal(first.endedAtMs, 0);
    assert.equal(first.startedAtMs, 0);

    const metadataPath = path.join(directory, `${TAKE_ID}.json`);
    const persistedBytes = await readFile(metadataPath);

    const restarted = new TakeLibrary({ directory });
    restarted.prepare();
    const second = restarted.get(TAKE_ID);
    assert.ok(second);
    assert.equal(second.recovered, true);
    assert.equal(second.endedAtMs, 0);
    assert.equal(second.startedAtMs, 0);
    assert.deepEqual(
      await readFile(metadataPath),
      persistedBytes,
      'recovery must not write a timestamp that its own parser rejects on the next restart',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
