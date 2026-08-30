import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { durableRename, durableRenameSync } from '../src/file-durability.js';

test('durableRename publishes a same-directory file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-durable-rename-'));
  try {
    const partialPath = path.join(directory, 'take.wav.part');
    const finalPath = path.join(directory, 'take.wav');
    await writeFile(partialPath, 'audio');

    await durableRename(partialPath, finalPath);

    assert.equal(await readFile(finalPath, 'utf8'), 'audio');
    await assert.rejects(readFile(partialPath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durableRenameSync publishes a same-directory file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-durable-rename-sync-'));
  try {
    const partialPath = path.join(directory, 'take.json.part');
    const finalPath = path.join(directory, 'take.json');
    await writeFile(partialPath, '{}');

    durableRenameSync(partialPath, finalPath);

    assert.equal(await readFile(finalPath, 'utf8'), '{}');
    await assert.rejects(readFile(partialPath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable rename refuses cross-directory use before mutating either path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-durable-rename-cross-'));
  try {
    const otherDirectory = path.join(directory, 'other');
    await mkdir(otherDirectory);
    const sourcePath = path.join(directory, 'source.part');
    const targetPath = path.join(otherDirectory, 'target');
    await writeFile(sourcePath, 'keep');

    await assert.rejects(
      durableRename(sourcePath, targetPath),
      /same directory/,
    );
    assert.equal(await readFile(sourcePath, 'utf8'), 'keep');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
