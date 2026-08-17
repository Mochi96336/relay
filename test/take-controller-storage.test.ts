import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeController } from '../src/take-controller.js';

const ORPHAN_TAKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('TakeController prepares storage at startup and removes an orphan partial', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-controller-boot-'));
  try {
    await writeFile(path.join(directory, `${ORPHAN_TAKE}.wav.part`), 'partial');

    new TakeController({
      directory,
      sampleRate: 48_000,
      storagePolicy: { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 },
      onStorageError: () => {},
    });

    assert.equal((await readdir(directory)).includes(`${ORPHAN_TAKE}.wav.part`), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TakeController rejects Start without entering a failed Take when storage reserve is unavailable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-controller-storage-'));
  try {
    const controller = new TakeController({
      directory,
      sampleRate: 48_000,
      storagePolicy: {
        maxBytes: 0,
        maxAgeMs: 0,
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      },
      onStorageError: () => {},
    });

    const result = controller.start('participant-a', {
      videoId: 'video-a',
      revision: 1,
      state: 1,
      serverTime: 10,
      playbackRate: 1,
    }, 100);

    assert.deepEqual(result, { ok: false, reason: 'storage-unavailable' });
    assert.equal(controller.lifecycle, 'idle');
    assert.equal(controller.recordingTakeId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
