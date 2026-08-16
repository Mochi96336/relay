import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  prepareTakeStorage,
  pruneTakeArtifacts,
  takeStorageBudget,
  type TakeStoragePolicy,
} from '../src/take-storage.js';

const TAKE_1 = '11111111-1111-4111-8111-111111111111';
const TAKE_2 = '22222222-2222-4222-8222-222222222222';
const TAKE_3 = '33333333-3333-4333-8333-333333333333';

const policy: TakeStoragePolicy = {
  maxBytes: 150,
  maxAgeMs: 10_000,
  minFreeBytes: 0,
};

async function setMtime(filePath: string, mtimeMs: number) {
  const when = new Date(mtimeMs);
  await utimes(filePath, when, when);
}

test('Take storage preparation removes orphan partials and prunes finalized WAVs by age then size', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-storage-'));
  const nowMs = Date.now();
  try {
    await writeFile(path.join(directory, `${TAKE_1}.wav.part`), 'partial');
    await writeFile(path.join(directory, 'notes.wav.part'), 'leave me alone');

    for (const [takeId, ageMs] of [
      [TAKE_1, 30_000],
      [TAKE_2, 5_000],
      [TAKE_3, 1_000],
    ] as const) {
      const filePath = path.join(directory, `${takeId}.wav`);
      await writeFile(filePath, Buffer.alloc(100));
      await setMtime(filePath, nowMs - ageMs);
    }

    const prepared = prepareTakeStorage(directory, policy, nowMs);
    assert.equal(prepared.removedPartialFiles, 1);
    assert.equal(prepared.removedArtifactFiles, 2);
    assert.ok(prepared.maxTakeDataBytes > 0);

    const names = await readdir(directory);
    assert.equal(names.includes(`${TAKE_1}.wav.part`), false);
    assert.equal(names.includes('notes.wav.part'), true);
    assert.equal(names.includes(`${TAKE_1}.wav`), false, 'expired artifact should be removed');
    assert.equal(names.includes(`${TAKE_2}.wav`), false, 'oldest retained artifact should satisfy size cap');
    assert.equal(names.includes(`${TAKE_3}.wav`), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('asynchronous retention never removes the currently preserved Take', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-retention-'));
  try {
    await writeFile(path.join(directory, `${TAKE_1}.wav`), Buffer.alloc(100));
    await writeFile(path.join(directory, `${TAKE_2}.wav`), Buffer.alloc(100));

    const result = await pruneTakeArtifacts(
      directory,
      { maxBytes: 50, maxAgeMs: 1, minFreeBytes: 0 },
      `${TAKE_2}.wav`,
      Date.now() + 10_000,
    );

    assert.equal(result.removedFiles, 1);
    const names = await readdir(directory);
    assert.equal(names.includes(`${TAKE_1}.wav`), false);
    assert.equal(names.includes(`${TAKE_2}.wav`), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Take storage refuses a new recording when the configured free-space reserve cannot be met', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-reserve-'));
  try {
    assert.throws(
      () => takeStorageBudget(directory, {
        maxBytes: 0,
        maxAgeMs: 0,
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
      /free-space reserve/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
