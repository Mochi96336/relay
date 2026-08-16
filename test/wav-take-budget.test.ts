import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WavTakeWriter } from '../src/wav-take-writer.js';

test('WavTakeWriter fails before writing past the per-Take disk budget', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-budget-'));
  const writer = new WavTakeWriter({
    directory,
    takeId: 'take-budget',
    sampleRate: 48_000,
    maxDataBytes: 1_920,
  });

  try {
    writer.append(Buffer.alloc(1_920));
    assert.equal(writer.sampleCount, 960);
    assert.throws(
      () => writer.append(Buffer.alloc(2)),
      /available WAV storage budget/,
    );
    assert.equal(writer.sampleCount, 960, 'rejected PCM must not count toward the Take');
  } finally {
    await writer.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await readdir(directory), []);
    await rm(directory, { recursive: true, force: true });
  }
});
