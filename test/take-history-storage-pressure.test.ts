import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeController } from '../src/take-controller.js';

const TAKE_ID = '77777777-7777-4777-8777-777777777777';
const BOUNDARY = { generation: 1, firstSampleIndex: 0 } as const;

function wav(sampleRate = 48_000, sampleCount = 4_800) {
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

test('storage reserve failure blocks new Takes without hiding readable history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-history-storage-pressure-'));
  const storageErrors: unknown[] = [];

  try {
    await writeFile(path.join(directory, `${TAKE_ID}.wav`), wav());

    const controller = new TakeController({
      directory,
      sampleRate: 48_000,
      storagePolicy: {
        maxBytes: 0,
        maxAgeMs: 0,
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      },
      onStorageError: (error) => { storageErrors.push(error); },
    });

    assert.equal(storageErrors.length, 1,
      'the impossible free-space reserve must remain visible as a storage fault');
    assert.deepEqual(
      controller.statusPayload().history.map((entry) => entry.takeId),
      [TAKE_ID],
      'readable durable history must remain available when only new recording storage is unavailable',
    );
    assert.equal(controller.statusPayload().history[0]?.recovered, true);
    assert.equal((await readdir(directory)).includes(`${TAKE_ID}.json`), true,
      'legacy recovery may still rebuild its metadata while recording admission remains blocked');

    const start = controller.start('participant-a', {
      videoId: null,
      revision: null,
      state: null,
      serverTime: null,
      playbackRate: null,
    }, BOUNDARY, 1_000);

    assert.deepEqual(start, { ok: false, reason: 'storage-unavailable' });
    assert.equal(storageErrors.length, 2,
      'Start must retry and report the still-unavailable recording storage');
    assert.deepEqual(
      controller.statusPayload().history.map((entry) => entry.takeId),
      [TAKE_ID],
      'a failed recording admission must not erase previously recovered history',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
