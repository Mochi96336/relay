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

test('TakeController publishes a finalized Take into durable recording history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-controller-history-'));
  try {
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const controller = new TakeController({
      directory,
      sampleRate: 48_000,
      storagePolicy: { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 },
      onStorageError: (error) => { throw error; },
      onChange: (status) => {
        if (status.lifecycle === 'ready') resolveReady?.();
      },
    });

    const started = controller.start('participant-a', {
      videoId: null,
      revision: null,
      state: null,
      serverTime: null,
      playbackRate: null,
    }, 1_000);
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const stopped = controller.stop(started.takeId, 'participant-a', 'user', 1_100);
    assert.equal(stopped.ok, true);
    await ready;

    const history = controller.listHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].takeId, started.takeId);
    assert.equal(history[0].recovered, false);
    assert.equal(history[0].startedByParticipantId, 'participant-a');
    assert.equal(history[0].endedAtMs, 1_100);
    assert.ok((await readdir(directory)).includes(`${started.takeId}.json`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
