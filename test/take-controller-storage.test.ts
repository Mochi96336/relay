import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeController } from '../src/take-controller.js';

const ORPHAN_TAKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const VOICE_ONLY_SONG = {
  videoId: null,
  revision: null,
  state: null,
  serverTime: null,
  playbackRate: null,
} as const;

async function settleStorageMaintenance(controller: TakeController) {
  // Finalization intentionally schedules retention after publishing the ready
  // lifecycle. Tests that delete their temporary Take directory must wait for
  // that maintenance chain rather than racing it during teardown.
  await (controller as unknown as { pruneChain: Promise<void> }).pruneChain;
}

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

test('TakeController publishes product-shaped finalized history beside lifecycle status', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-controller-history-'));
  try {
    let resolveReady: (() => void) | null = null;
    let readyHistory: readonly { takeId: string }[] = [];
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const controller = new TakeController({
      directory,
      sampleRate: 48_000,
      storagePolicy: { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 },
      onStorageError: (error) => { throw error; },
      onChange: (status) => {
        if (status.lifecycle === 'ready') {
          readyHistory = status.history;
          resolveReady?.();
        }
      },
    });

    const started = controller.start('participant-a', VOICE_ONLY_SONG, 1_000);
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const stopped = controller.stop(started.takeId, 'participant-a', 'user', 1_100);
    assert.equal(stopped.ok, true);
    await ready;
    await settleStorageMaintenance(controller);

    assert.deepEqual(readyHistory.map((entry) => entry.takeId), [started.takeId]);
    const productEntry = controller.statusPayload().history[0];
    assert.equal(productEntry.takeId, started.takeId);
    assert.equal(productEntry.endedAtMs, 1_100);
    assert.equal(productEntry.songVideoId, null);
    assert.deepEqual(
      Object.keys(productEntry).sort(),
      ['artifact', 'endedAtMs', 'qualityVerdict', 'recovered', 'songVideoId', 'takeId'].sort(),
      'browser history must be a deliberate product DTO rather than the durable metadata schema',
    );
    assert.deepEqual(Object.keys(productEntry.artifact).sort(), ['durationMs', 'url'].sort());
    assert.equal('startedByParticipantId' in productEntry, false);
    assert.equal('stoppedByParticipantId' in productEntry, false);
    assert.equal('stopReason' in productEntry, false);
    assert.equal('quality' in productEntry, false);

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

test('current Take lifecycle can advance while durable history retains prior Takes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-controller-boundary-'));
  try {
    let resolveReady: (() => void) | null = null;
    const controller = new TakeController({
      directory,
      sampleRate: 48_000,
      storagePolicy: { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 },
      onStorageError: (error) => { throw error; },
      onChange: (status) => {
        if (status.lifecycle === 'ready') resolveReady?.();
      },
    });

    async function finalize(actor: string, startedAtMs: number, endedAtMs: number) {
      const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
      const started = controller.start(actor, VOICE_ONLY_SONG, startedAtMs);
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error('Take unexpectedly failed to start.');
      assert.equal(controller.stop(started.takeId, actor, 'user', endedAtMs).ok, true);
      await ready;
      resolveReady = null;
      await settleStorageMaintenance(controller);
      return started.takeId;
    }

    const firstTakeId = await finalize('participant-a', 1_000, 1_100);
    assert.equal(controller.statusPayload().take?.takeId, firstTakeId);

    const secondTakeId = await finalize('participant-b', 2_000, 2_100);
    const current = controller.statusPayload();
    assert.equal(current.take?.takeId, secondTakeId,
      'TakeSession remains the single current lifecycle authority');
    assert.notEqual(current.take?.takeId, firstTakeId);
    assert.deepEqual(
      current.history.map((entry) => entry.takeId),
      [secondTakeId, firstTakeId],
      'status carries the product history snapshot without replacing current lifecycle authority',
    );

    const history = controller.listHistory();
    assert.deepEqual(
      history.map((entry) => entry.takeId),
      [secondTakeId, firstTakeId],
      'TakeLibrary owns durable multi-recording history independently of current lifecycle state',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('status delivery reads cached Take history instead of scanning storage', async () => {
  const source = await readFile(new URL('../src/take-controller.ts', import.meta.url), 'utf8');
  const statusStart = source.indexOf('statusPayload(): TakeControllerStatusPayload');
  const listStart = source.indexOf('\n  listHistory()', statusStart);
  assert.ok(statusStart >= 0 && listStart > statusStart);
  const statusMethod = source.slice(statusStart, listStart);

  assert.match(statusMethod, /history: this\.historyCache/);
  assert.doesNotMatch(statusMethod, /library\.list|readdir|readFile/,
    'normal product/status updates must not rescan Take metadata on disk');
  assert.match(source, /if \(this\.refreshHistoryCache\(\)\) this\.emitChange\(\)/,
    'retention must publish a new snapshot when it removes or changes visible Takes');
});
