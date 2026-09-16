import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeController } from '../src/take-controller.js';
import type { TakeStoragePolicy } from '../src/take-storage.js';

const VOICE_ONLY_SONG = {
  videoId: null,
  revision: null,
  state: null,
  serverTime: null,
  playbackRate: null,
} as const;

async function settleStorageMaintenance(controller: TakeController) {
  await (controller as unknown as { pruneChain: Promise<void> }).pruneChain;
}

test('partial retention failure still converges cached history to durable WAV state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-retention-history-failure-'));
  const storagePolicy: TakeStoragePolicy = { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 };
  const storageErrors: unknown[] = [];
  let resolveReady: (() => void) | null = null;

  const controller = new TakeController({
    directory,
    sampleRate: 48_000,
    storagePolicy,
    onStorageError: (error) => { storageErrors.push(error); },
    onChange: (status) => {
      if (status.lifecycle === 'ready') resolveReady?.();
    },
  });

  async function finalize(generation: number, startedAtMs: number) {
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const boundary = { generation, firstSampleIndex: 0 };
    const started = controller.start('participant-a', VOICE_ONLY_SONG, boundary, startedAtMs);
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error('Take unexpectedly failed to start.');
    assert.equal(controller.stop(started.takeId, 'participant-a', boundary, 'user', startedAtMs + 100).ok, true);
    await ready;
    resolveReady = null;
    await settleStorageMaintenance(controller);
    return started.takeId;
  }

  try {
    const firstTakeId = await finalize(1, 1_000);
    const secondTakeId = await finalize(2, 2_000);
    assert.deepEqual(
      controller.statusPayload().history.map((entry) => entry.takeId),
      [secondTakeId, firstTakeId],
    );

    // Force failure specifically after retention has durably invalidated the
    // first WAV: a directory at the paired metadata path can be statted but
    // cannot be removed by the non-recursive durable file-removal primitive.
    const firstMetadataPath = path.join(directory, `${firstTakeId}.json`);
    await rm(firstMetadataPath, { force: true });
    await mkdir(firstMetadataPath);

    // Two zero-sample WAVs are 44 bytes each. Keep the current/latest Take and
    // require the older one to be pruned by the 44-byte budget.
    storagePolicy.maxBytes = 44;
    (controller as unknown as { scheduleRetentionPrune(): void }).scheduleRetentionPrune();
    await settleStorageMaintenance(controller);

    assert.equal(storageErrors.length, 1, 'the metadata cleanup fault must remain observable');
    const names = await readdir(directory);
    assert.equal(names.includes(`${firstTakeId}.wav`), false,
      'the older WAV crossed the durable retention invalidation boundary');
    assert.equal(names.includes(`${secondTakeId}.wav`), true,
      'the current Take remains protected from retention');
    assert.deepEqual(
      controller.statusPayload().history.map((entry) => entry.takeId),
      [secondTakeId],
      'cached product history must reflect the missing authoritative WAV even when later cleanup fails',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
