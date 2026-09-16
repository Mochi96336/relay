import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeController } from '../src/take-controller.js';
import type { TakeStoragePolicy } from '../src/take-storage.js';

const BOUNDARY = { generation: 1, firstSampleIndex: 0 } as const;
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

test('retention can retire the last ready Take without leaving stale current artifact state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-retention-ready-retire-'));
  const storagePolicy: TakeStoragePolicy = { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 };
  let resolveReady: (() => void) | null = null;
  const changes: Array<{ lifecycle: string; history: readonly { takeId: string }[] }> = [];

  try {
    const controller = new TakeController({
      directory,
      sampleRate: 48_000,
      storagePolicy,
      onStorageError: (error) => { throw error; },
      onChange: (status) => {
        changes.push({ lifecycle: status.lifecycle, history: status.history });
        if (status.lifecycle === 'ready') resolveReady?.();
      },
    });

    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const started = controller.start('participant-a', VOICE_ONLY_SONG, BOUNDARY, 1_000);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(controller.stop(started.takeId, 'participant-a', BOUNDARY, 'user', 1_100).ok, true);
    await ready;
    resolveReady = null;
    await settleStorageMaintenance(controller);

    const before = controller.statusPayload();
    assert.equal(before.lifecycle, 'ready');
    assert.equal(before.take?.takeId, started.takeId);
    assert.deepEqual(before.history.map((entry) => entry.takeId), [started.takeId]);
    assert.equal((await readdir(directory)).includes(`${started.takeId}.wav`), true);

    // A zero-sample PCM WAV is exactly 44 bytes. Tighten the policy below that
    // after the Take is ready, then run the same retention maintenance path.
    storagePolicy.maxBytes = 43;
    (controller as unknown as { scheduleRetentionPrune(): void }).scheduleRetentionPrune();
    await settleStorageMaintenance(controller);

    const after = controller.statusPayload();
    assert.equal(after.lifecycle, 'idle',
      'a ready Take whose authoritative artifact was retained away must not remain current');
    assert.equal(after.take, null);
    assert.deepEqual(after.history, []);
    const names = await readdir(directory);
    assert.equal(names.includes(`${started.takeId}.wav`), false);
    assert.equal(names.includes(`${started.takeId}.json`), false);
    assert.deepEqual(changes.at(-1), { lifecycle: 'idle', history: [] },
      'retention reconciliation must publish one product state with current and history aligned');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
