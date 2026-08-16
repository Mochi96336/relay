import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const WAV_HEADER_BYTES = 44;
const TAKE_WAV_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$/i;
const TAKE_PART_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav\.part$/i;

export type TakeStoragePolicy = {
  maxBytes: number;
  maxAgeMs: number;
  minFreeBytes: number;
};

export type TakeStoragePreparation = {
  removedPartialFiles: number;
  removedArtifactFiles: number;
  maxTakeDataBytes: number;
};

type ArtifactRecord = {
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
};

function envNonNegative(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Pi-safe defaults: enough room for several long sessions without allowing
 * forgotten PCM WAV files to grow forever. Set either retention limit to 0 to
 * disable that dimension explicitly.
 */
export function takeStoragePolicyFromEnv(): TakeStoragePolicy {
  return {
    maxBytes: Math.floor(envNonNegative('RELAY_TAKE_MAX_GIB', 10) * GIB),
    maxAgeMs: envNonNegative('RELAY_TAKE_RETENTION_DAYS', 7) * DAY_MS,
    minFreeBytes: Math.floor(envNonNegative('RELAY_TAKE_MIN_FREE_GIB', 1) * GIB),
  };
}

function artifactNamesToRemove(
  records: ArtifactRecord[],
  policy: TakeStoragePolicy,
  preserveFileName: string | null,
  nowMs: number,
) {
  const removals = new Set<string>();

  if (policy.maxAgeMs > 0) {
    for (const record of records) {
      if (
        record.fileName !== preserveFileName
        && nowMs - record.mtimeMs > policy.maxAgeMs
      ) removals.add(record.fileName);
    }
  }

  if (policy.maxBytes > 0) {
    let retainedBytes = records.reduce(
      (total, record) => total + (removals.has(record.fileName) ? 0 : record.sizeBytes),
      0,
    );
    const oldestFirst = records
      .filter((record) => !removals.has(record.fileName))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const record of oldestFirst) {
      if (retainedBytes <= policy.maxBytes) break;
      if (record.fileName === preserveFileName) continue;
      removals.add(record.fileName);
      retainedBytes -= record.sizeBytes;
    }
  }

  return removals;
}

function currentTakeBudget(directory: string, policy: TakeStoragePolicy) {
  const filesystem = statfsSync(directory);
  const freeBytes = filesystem.bavail * filesystem.bsize;
  const freeDataBytes = freeBytes - policy.minFreeBytes - WAV_HEADER_BYTES;
  if (!Number.isFinite(freeDataBytes) || freeDataBytes <= 0) {
    throw new Error('Take storage does not have the configured free-space reserve.');
  }

  const policyDataBytes = policy.maxBytes > 0
    ? policy.maxBytes - WAV_HEADER_BYTES
    : freeDataBytes;
  const writableBytes = Math.floor(Math.min(freeDataBytes, policyDataBytes) / 2) * 2;
  if (writableBytes <= 0) {
    throw new Error('Take storage retention budget is too small for a PCM WAV artifact.');
  }
  return writableBytes;
}

/**
 * Runs only on the control-plane path before the first Take of this process.
 * This directory is single-writer storage owned by one Relay process.
 */
export function prepareTakeStorage(
  directory: string,
  policy: TakeStoragePolicy,
  nowMs = Date.now(),
): TakeStoragePreparation {
  mkdirSync(directory, { recursive: true });

  let removedPartialFiles = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !TAKE_PART_PATTERN.test(entry.name)) continue;
    rmSync(path.join(directory, entry.name), { force: true });
    removedPartialFiles += 1;
  }

  const artifacts: ArtifactRecord[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !TAKE_WAV_PATTERN.test(entry.name)) continue;
    const info = statSync(path.join(directory, entry.name));
    artifacts.push({ fileName: entry.name, sizeBytes: info.size, mtimeMs: info.mtimeMs });
  }

  const removals = artifactNamesToRemove(artifacts, policy, null, nowMs);
  for (const fileName of removals) rmSync(path.join(directory, fileName), { force: true });

  return {
    removedPartialFiles,
    removedArtifactFiles: removals.size,
    maxTakeDataBytes: currentTakeBudget(directory, policy),
  };
}

export function takeStorageBudget(directory: string, policy: TakeStoragePolicy) {
  mkdirSync(directory, { recursive: true });
  return currentTakeBudget(directory, policy);
}

/**
 * Prunes only finalized WAVs. It deliberately ignores `.part` files so this
 * asynchronous maintenance can never race a newly started Take writer.
 */
export async function pruneTakeArtifacts(
  directory: string,
  policy: TakeStoragePolicy,
  preserveFileName: string | null,
  nowMs = Date.now(),
) {
  await mkdir(directory, { recursive: true });
  const artifacts: ArtifactRecord[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !TAKE_WAV_PATTERN.test(entry.name)) continue;
    try {
      const info = await stat(path.join(directory, entry.name));
      artifacts.push({ fileName: entry.name, sizeBytes: info.size, mtimeMs: info.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const removals = artifactNamesToRemove(artifacts, policy, preserveFileName, nowMs);
  let removedBytes = 0;
  for (const record of artifacts) {
    if (!removals.has(record.fileName)) continue;
    await rm(path.join(directory, record.fileName), { force: true });
    removedBytes += record.sizeBytes;
  }

  return { removedFiles: removals.size, removedBytes };
}
