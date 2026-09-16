import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WavTakeWriter } from '../src/wav-take-writer.js';

function isPermissionError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === 'EACCES' || code === 'EPERM';
}

async function restoreWritable(directory: string) {
  await chmod(directory, 0o700).catch(() => {});
}

test('abort surfaces a stable-WAV cleanup failure instead of silently accepting it', {
  skip: process.platform === 'win32' ? 'POSIX directory permissions are required for this regression.' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-abort-cleanup-error-'));
  const writer = new WavTakeWriter({
    directory,
    takeId: 'take-abort-cleanup-error',
    sampleRate: 48_000,
  });

  try {
    writer.append(Buffer.alloc(1_920));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(writer.filePath, 'ambiguous-published-wav');
    await chmod(directory, 0o500);

    await assert.rejects(
      writer.abort(),
      isPermissionError,
      'a failed stable-file unlink must escape abort() so the controller can report it',
    );

    await restoreWritable(directory);
    await writer.abort();
    assert.deepEqual(await readdir(directory), [], 'a later abort can retry and finish the cleanup');
  } finally {
    await restoreWritable(directory);
    await writer.abort().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed discard clears finalized authority so abort can retry the stable WAV', {
  skip: process.platform === 'win32' ? 'POSIX directory permissions are required for this regression.' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-discard-cleanup-error-'));
  const writer = new WavTakeWriter({
    directory,
    takeId: 'take-discard-cleanup-error',
    sampleRate: 48_000,
  });

  try {
    writer.append(Buffer.alloc(1_920));
    await writer.finalize();
    await chmod(directory, 0o500);

    await assert.rejects(
      writer.discardFinalized(),
      isPermissionError,
      'discarding a rejected finalized Take must expose durable cleanup failure',
    );

    await restoreWritable(directory);
    await writer.abort();
    assert.deepEqual(
      await readdir(directory),
      [],
      'discard failure must leave the writer eligible for abort() to retry the stable path',
    );
  } finally {
    await restoreWritable(directory);
    await writer.abort().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('TakeController routes every writer abort through storage-error reporting', async () => {
  const source = await readFile(new URL('../src/take-controller.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /private async abortWriter\(writer: WavTakeWriter\) \{\s*try \{\s*await writer\.abort\(\);\s*\} catch \(error\) \{\s*this\.reportStorageError\(error\);\s*\}\s*\}/s,
  );
  assert.match(source, /if \(orphanWriter\) await this\.abortWriter\(orphanWriter\);/);
  assert.match(source, /await this\.abortWriter\(writer\);/);
  assert.match(source, /void this\.abortWriter\(writer\);/);

  const directAbortCalls = source.match(/\bwriter\.abort\(\)/g) ?? [];
  assert.equal(
    directAbortCalls.length,
    1,
    'the helper itself must be the only direct writer.abort() call so cleanup rejection cannot escape unobserved',
  );
});
