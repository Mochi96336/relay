import { closeSync, fsyncSync, openSync, renameSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import path from 'node:path';

function assertSameDirectory(sourcePath: string, targetPath: string) {
  const sourceDirectory = path.resolve(path.dirname(sourcePath));
  const targetDirectory = path.resolve(path.dirname(targetPath));
  if (sourceDirectory !== targetDirectory) {
    throw new Error('Durable rename requires source and target in the same directory.');
  }
  return targetDirectory;
}

/**
 * Flush a directory entry update on POSIX filesystems. Relay production runs on
 * Linux/Pi, where syncing the parent directory is the durability barrier after
 * rename. Windows does not expose the same directory-fsync path through Node,
 * so local Windows development keeps atomic rename semantics without failing.
 */
async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function syncDirectorySync(directory: string) {
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function durableRename(sourcePath: string, targetPath: string) {
  const directory = assertSameDirectory(sourcePath, targetPath);
  await rename(sourcePath, targetPath);
  await syncDirectory(directory);
}

export function durableRenameSync(sourcePath: string, targetPath: string) {
  const directory = assertSameDirectory(sourcePath, targetPath);
  renameSync(sourcePath, targetPath);
  syncDirectorySync(directory);
}
