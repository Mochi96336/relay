import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wavWriter = await readFile(new URL('../src/wav-take-writer.ts', import.meta.url), 'utf8');
const library = await readFile(new URL('../src/take-library.ts', import.meta.url), 'utf8');
const durability = await readFile(new URL('../src/file-durability.ts', import.meta.url), 'utf8');

test('Take publication flushes file contents before durable same-directory rename', () => {
  assert.match(wavWriter, /await handle\.sync\(\);[\s\S]*await durableRename\(this\.partPath, this\.filePath\);/);
  assert.match(library, /writeFileSync\(partialPath,[\s\S]*flush: true[\s\S]*durableRenameSync\(partialPath, finalPath\);/);
  assert.match(library, /durableRenameSync\(metadataPartPath, metadataPath\);/);
});

test('durable rename syncs the parent directory on non-Windows platforms', () => {
  assert.match(durability, /process\.platform === 'win32'/);
  assert.match(durability, /await rename\(sourcePath, targetPath\);[\s\S]*await syncDirectory\(directory\);/);
  assert.match(durability, /renameSync\(sourcePath, targetPath\);[\s\S]*syncDirectorySync\(directory\);/);
  assert.match(durability, /await handle\.sync\(\);/);
  assert.match(durability, /fsyncSync\(descriptor\);/);
});
