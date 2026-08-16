import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeController } from '../src/take-controller.js';

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
