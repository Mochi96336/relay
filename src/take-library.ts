import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { durableRenameSync } from './file-durability.js';
import { normalizePersistedTakeRichFields } from './take-metadata-validation.js';
import type {
  TakeArtifact,
  TakeMixSampleRange,
  TakeRecord,
  TakeSongSnapshot,
  TakeStopReason,
} from './take-session.js';
import type { TakeQualityAssessment } from './take-quality.js';

const WAV_HEADER_BYTES = 44;
const MAX_JS_DATE_MS = 8_640_000_000_000_000;
const TAKE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAKE_WAV_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.wav$/i;
const TAKE_METADATA_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const TAKE_METADATA_PART_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json\.part$/i;

export type TakeLibraryEntry = {
  takeId: string;
  startedAtMs: number;
  endedAtMs: number;
  startedByParticipantId: string | null;
  stoppedByParticipantId: string | null;
  stopReason: TakeStopReason | null;
  song: TakeSongSnapshot | null;
  artifact: TakeArtifact;
  mixSampleRange: TakeMixSampleRange | null;
  quality: TakeQualityAssessment | null;
  recovered: boolean;
};

type PersistedTakeArtifact = Omit<TakeArtifact, 'url' | 'durationMs'> & {
  url?: unknown;
  durationMs?: unknown;
};

type PersistedTakeLibraryEntry = Omit<TakeLibraryEntry, 'artifact'> & {
  artifact: PersistedTakeArtifact;
};

type TakeMetadataV1 = {
  version: 1;
  take: TakeLibraryEntry;
};

function metadataFileName(takeId: string) {
  return `${takeId}.json`;
}

function metadataPartFileName(takeId: string) {
  return `${takeId}.json.part`;
}

function artifactUrl(base: string, takeId: string) {
  return `${base.replace(/\/$/, '')}/${encodeURIComponent(takeId)}.wav`;
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validWallClockMs(value: unknown) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_JS_DATE_MS;
}

function isTakeMixSampleRange(value: unknown): value is TakeMixSampleRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as Partial<TakeMixSampleRange>;
  if (!Number.isSafeInteger(range.generation) || Number(range.generation) < 0) return false;
  if (!Number.isSafeInteger(range.startSampleIndex) || Number(range.startSampleIndex) < 0) return false;
  if (!Number.isSafeInteger(range.endSampleIndex) || Number(range.endSampleIndex) < Number(range.startSampleIndex)) {
    return false;
  }
  if (!Number.isSafeInteger(range.sampleCount) || Number(range.sampleCount) < 0) return false;
  return Number(range.sampleCount) <= Number(range.endSampleIndex) - Number(range.startSampleIndex);
}

function isPersistedTakeLibraryEntry(value: unknown): value is PersistedTakeLibraryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PersistedTakeLibraryEntry>;
  if (typeof entry.takeId !== 'string' || !TAKE_ID_PATTERN.test(entry.takeId)) return false;
  if (!validWallClockMs(entry.startedAtMs) || !validWallClockMs(entry.endedAtMs)) return false;
  if (entry.startedByParticipantId !== null && typeof entry.startedByParticipantId !== 'string') return false;
  if (entry.stoppedByParticipantId !== null && typeof entry.stoppedByParticipantId !== 'string') return false;
  if (!entry.artifact || typeof entry.artifact !== 'object') return false;
  if (entry.artifact.fileName !== `${entry.takeId}.wav`) return false;
  if (entry.artifact.mimeType !== 'audio/wav') return false;
  if (!finiteNumber(entry.artifact.sampleCount)) return false;
  if (!finiteNumber(entry.artifact.sampleRate) || !finiteNumber(entry.artifact.sizeBytes)) return false;
  return entry.artifact.channels === 1 && entry.artifact.bitsPerSample === 16;
}

function parseMetadata(bytes: Buffer, expectedTakeId: string) {
  const decoded = JSON.parse(bytes.toString('utf8')) as { version?: unknown; take?: unknown };
  if (decoded.version !== 1 || !isPersistedTakeLibraryEntry(decoded.take)) return null;
  if (decoded.take.takeId !== expectedTakeId) return null;

  const rich = normalizePersistedTakeRichFields(decoded.take);
  if (!rich) return null;
  const rawRange = (decoded.take as PersistedTakeLibraryEntry & { mixSampleRange?: unknown }).mixSampleRange;
  if (rawRange !== undefined && rawRange !== null && !isTakeMixSampleRange(rawRange)) return null;
  return {
    ...decoded.take,
    ...rich,
    mixSampleRange: rawRange && isTakeMixSampleRange(rawRange) ? { ...rawRange } : null,
  } satisfies PersistedTakeLibraryEntry;
}

function readWavArtifact(filePath: string, takeId: string, baseUrl: string): TakeArtifact {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const descriptor = openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = readSync(descriptor, header, 0, WAV_HEADER_BYTES, 0);
  } finally {
    closeSync(descriptor);
  }
  if (bytesRead < WAV_HEADER_BYTES) throw new Error('Take WAV header is incomplete.');
  if (
    header.toString('ascii', 0, 4) !== 'RIFF'
    || header.toString('ascii', 8, 12) !== 'WAVE'
    || header.toString('ascii', 12, 16) !== 'fmt '
    || header.toString('ascii', 36, 40) !== 'data'
  ) throw new Error('Take WAV header is invalid.');

  const riffBytes = header.readUInt32LE(4);
  const fmtBytes = header.readUInt32LE(16);
  const audioFormat = header.readUInt16LE(20);
  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const byteRate = header.readUInt32LE(28);
  const blockAlign = header.readUInt16LE(32);
  const bitsPerSample = header.readUInt16LE(34);
  const dataBytes = header.readUInt32LE(40);
  if (
    fmtBytes !== 16
    || audioFormat !== 1
    || channels !== 1
    || bitsPerSample !== 16
    || sampleRate <= 0
    || byteRate !== sampleRate * 2
    || blockAlign !== 2
  ) {
    throw new Error('Take WAV format is unsupported.');
  }
  if (dataBytes % 2 !== 0) throw new Error('Take WAV PCM payload is not 16-bit aligned.');

  const info = statSync(filePath);
  if (riffBytes !== 36 + dataBytes || info.size !== WAV_HEADER_BYTES + dataBytes) {
    throw new Error('Take WAV length is inconsistent with its header.');
  }
  const sampleCount = dataBytes / 2;
  return {
    fileName: `${takeId}.wav`,
    url: artifactUrl(baseUrl, takeId),
    mimeType: 'audio/wav',
    sizeBytes: info.size,
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    sampleCount,
    durationMs: (sampleCount / sampleRate) * 1000,
  };
}

function recoveredEntryFromWav(
  wavPath: string,
  takeId: string,
  baseUrl: string,
): TakeLibraryEntry {
  const artifact = readWavArtifact(wavPath, takeId, baseUrl);
  const endedAtMs = Math.min(MAX_JS_DATE_MS, Math.max(0, statSync(wavPath).mtimeMs));
  return {
    takeId,
    startedAtMs: Math.max(0, endedAtMs - artifact.durationMs),
    endedAtMs,
    startedByParticipantId: null,
    stoppedByParticipantId: null,
    stopReason: null,
    song: null,
    artifact,
    mixSampleRange: null,
    quality: null,
    recovered: true,
  };
}

function readValidatedMetadata(
  metadataPath: string,
  wavPath: string,
  takeId: string,
  baseUrl: string,
  useWavArtifact: true,
): TakeLibraryEntry | null;
function readValidatedMetadata(
  metadataPath: string,
  wavPath: string,
  takeId: string,
  baseUrl: string,
  useWavArtifact?: false,
): PersistedTakeLibraryEntry | null;
function readValidatedMetadata(
  metadataPath: string,
  wavPath: string,
  takeId: string,
  baseUrl: string,
  useWavArtifact = false,
) {
  const metadata = parseMetadata(readFileSync(metadataPath), takeId);
  if (!metadata) return null;

  const artifact = readWavArtifact(wavPath, takeId, baseUrl);
  if (
    metadata.artifact.sampleCount !== artifact.sampleCount
    || metadata.artifact.sampleRate !== artifact.sampleRate
    || metadata.artifact.sizeBytes !== artifact.sizeBytes
  ) return null;
  if (
    metadata.mixSampleRange !== null
    && metadata.mixSampleRange.sampleCount !== artifact.sampleCount
  ) return null;
  return useWavArtifact ? { ...metadata, artifact } : metadata;
}

function cloneEntry(entry: TakeLibraryEntry): TakeLibraryEntry {
  return {
    ...entry,
    song: entry.song ? { ...entry.song } : null,
    artifact: { ...entry.artifact },
    mixSampleRange: entry.mixSampleRange ? { ...entry.mixSampleRange } : null,
    quality: entry.quality ? structuredClone(entry.quality) : null,
  };
}

function entryFromTake(take: TakeRecord, artifact: TakeArtifact): TakeLibraryEntry {
  if (take.endedAtMs === null) throw new Error('Take metadata requires a settled end time.');
  return {
    takeId: take.takeId,
    startedAtMs: take.startedAtMs,
    endedAtMs: take.endedAtMs,
    startedByParticipantId: take.startedByParticipantId,
    stoppedByParticipantId: take.stoppedByParticipantId,
    stopReason: take.stopReason,
    song: { ...take.song },
    artifact: { ...artifact },
    mixSampleRange: take.mixSampleRange ? { ...take.mixSampleRange } : null,
    quality: take.quality ? structuredClone(take.quality) : null,
    recovered: false,
  };
}

/**
 * Persistent history for finalized recordings.
 *
 * TakeSession remains the authority for the one live recording lifecycle. This
 * library owns only durable, finalized artifacts and their metadata. Legacy WAV
 * files are recovered into sidecars so a Relay restart does not erase recording
 * history just because older versions stored only the audio file.
 */
export class TakeLibrary {
  private readonly artifactBaseUrl: string;
  private readonly stagedTakeIds = new Set<string>();

  constructor(private readonly options: { directory: string; artifactBaseUrl?: string }) {
    this.artifactBaseUrl = options.artifactBaseUrl ?? '/takes';
  }

  prepare() {
    mkdirSync(this.options.directory, { recursive: true });
    this.recoverLegacyArtifacts();
  }

  /**
   * Durably stages rich metadata before the corresponding WAV is published.
   * A crash before WAV rename leaves an orphan partial that startup removes; a
   * crash after WAV rename leaves a complete transaction candidate that startup
   * can validate and promote without degrading to WAV-only recovery.
   */
  stageFinalizing(take: TakeRecord, audio: { sampleRate: number; sampleCount: number }) {
    if (take.lifecycle !== 'finalizing' || take.artifact !== null || take.endedAtMs === null) {
      throw new Error('Only a finalizing Take without an artifact can stage recording metadata.');
    }
    if (!TAKE_ID_PATTERN.test(take.takeId)) throw new Error('Take id is invalid.');
    if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) {
      throw new Error('Take staged sample rate is invalid.');
    }
    if (!Number.isSafeInteger(audio.sampleCount) || audio.sampleCount < 0) {
      throw new Error('Take staged sample count is invalid.');
    }
    if (!take.mixSampleRange || take.mixSampleRange.sampleCount !== audio.sampleCount) {
      throw new Error('Take staged sample count does not match its authoritative mix range.');
    }
    const sizeBytes = WAV_HEADER_BYTES + audio.sampleCount * 2;
    if (!Number.isSafeInteger(sizeBytes)) throw new Error('Take staged WAV size is invalid.');

    const artifact: TakeArtifact = {
      fileName: `${take.takeId}.wav`,
      // Match TakeController's existing ready-artifact URL byte-for-byte. The
      // recovery reader normalizes its fallback URL, but staged metadata must
      // compare equal to the live Take without changing existing URL behavior.
      url: `${this.artifactBaseUrl}/${encodeURIComponent(take.takeId)}.wav`,
      mimeType: 'audio/wav',
      sizeBytes,
      sampleRate: audio.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: audio.sampleCount,
      durationMs: (audio.sampleCount / audio.sampleRate) * 1000,
    };
    const entry = entryFromTake(take, artifact);
    mkdirSync(this.options.directory, { recursive: true });
    this.writeMetadataPartial(entry);
    this.stagedTakeIds.add(take.takeId);
    return cloneEntry(entry);
  }

  commitStaged(take: TakeRecord) {
    if (take.lifecycle !== 'ready' || !take.artifact || take.endedAtMs === null) {
      throw new Error('Only a finalized ready Take can commit staged recording metadata.');
    }
    if (!TAKE_ID_PATTERN.test(take.takeId)) throw new Error('Take id is invalid.');

    const expected = entryFromTake(take, take.artifact);
    const partialPath = path.join(this.options.directory, metadataPartFileName(take.takeId));
    const finalPath = path.join(this.options.directory, metadataFileName(take.takeId));
    const wavPath = path.join(this.options.directory, take.artifact.fileName);

    let staged: PersistedTakeLibraryEntry | null;
    try {
      staged = readValidatedMetadata(partialPath, wavPath, take.takeId, this.artifactBaseUrl);
    } catch (error) {
      const partialWasPromoted = Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ENOENT',
      );
      if (!partialWasPromoted) throw error;

      let committed: PersistedTakeLibraryEntry | null = null;
      try {
        committed = readValidatedMetadata(finalPath, wavPath, take.takeId, this.artifactBaseUrl);
      } catch {}
      if (!committed || JSON.stringify(committed) !== JSON.stringify(expected)) {
        throw new Error('Staged Take metadata does not match the finalized recording.');
      }
      this.stagedTakeIds.delete(take.takeId);
      return cloneEntry(expected);
    }

    if (!staged || JSON.stringify(staged) !== JSON.stringify(expected)) {
      throw new Error('Staged Take metadata does not match the finalized recording.');
    }

    durableRenameSync(partialPath, finalPath);
    this.stagedTakeIds.delete(take.takeId);
    return cloneEntry(expected);
  }

  discardStaged(takeId: string) {
    if (!TAKE_ID_PATTERN.test(takeId)) throw new Error('Take id is invalid.');
    this.stagedTakeIds.delete(takeId);
    rmSync(path.join(this.options.directory, metadataPartFileName(takeId)), { force: true });
  }

  record(take: TakeRecord) {
    if (take.lifecycle !== 'ready' || !take.artifact || take.endedAtMs === null) {
      throw new Error('Only finalized ready Takes can enter the recording library.');
    }
    if (!TAKE_ID_PATTERN.test(take.takeId)) throw new Error('Take id is invalid.');
    if (take.artifact.fileName !== `${take.takeId}.wav`) {
      throw new Error('Take artifact file does not match its id.');
    }

    mkdirSync(this.options.directory, { recursive: true });
    const artifactInfo = statSync(path.join(this.options.directory, take.artifact.fileName));
    if (!artifactInfo.isFile()) throw new Error('Take artifact is not a file.');

    const entry = entryFromTake(take, take.artifact);
    this.writeMetadata(entry);
    return cloneEntry(entry);
  }

  list() {
    mkdirSync(this.options.directory, { recursive: true });
    const recoveryFallbacks = this.recoverLegacyArtifacts();
    const entries: TakeLibraryEntry[] = [];
    const seenTakeIds = new Set<string>();
    const names = new Set(readdirSync(this.options.directory));

    for (const item of readdirSync(this.options.directory, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const match = TAKE_METADATA_PATTERN.exec(item.name);
      if (!match) continue;
      const takeId = match[1];
      if (!names.has(`${takeId}.wav`)) continue;
      try {
        const metadata = readValidatedMetadata(
          path.join(this.options.directory, item.name),
          path.join(this.options.directory, `${takeId}.wav`),
          takeId,
          this.artifactBaseUrl,
          true,
        );
        if (metadata) {
          entries.push(metadata);
          seenTakeIds.add(takeId);
        }
      } catch {
        // Recovery already repaired malformed/mismatched sidecars where possible.
      }
    }

    for (const [takeId, entry] of recoveryFallbacks) {
      if (!seenTakeIds.has(takeId)) entries.push(entry);
    }

    return entries
      .sort((a, b) => b.endedAtMs - a.endedAtMs)
      .map(cloneEntry);
  }

  get(takeId: string) {
    if (!TAKE_ID_PATTERN.test(takeId)) return null;
    mkdirSync(this.options.directory, { recursive: true });
    const recoveryFallback = this.recoverLegacyArtifacts().get(takeId) ?? null;
    const metadataPath = path.join(this.options.directory, metadataFileName(takeId));
    const wavPath = path.join(this.options.directory, `${takeId}.wav`);
    try {
      const entry = readValidatedMetadata(
        metadataPath,
        wavPath,
        takeId,
        this.artifactBaseUrl,
        true,
      );
      if (entry) return cloneEntry(entry);
    } catch {}
    return recoveryFallback ? cloneEntry(recoveryFallback) : null;
  }

  remove(takeId: string) {
    if (!TAKE_ID_PATTERN.test(takeId)) return false;
    this.stagedTakeIds.delete(takeId);
    const wavPath = path.join(this.options.directory, `${takeId}.wav`);
    const existed = (() => {
      try {
        statSync(wavPath);
        return true;
      } catch {
        return false;
      }
    })();
    rmSync(wavPath, { force: true });
    rmSync(path.join(this.options.directory, metadataFileName(takeId)), { force: true });
    rmSync(path.join(this.options.directory, metadataPartFileName(takeId)), { force: true });
    return existed;
  }

  private recoverLegacyArtifacts() {
    const names = new Set(readdirSync(this.options.directory));
    const recoveryFallbacks = new Map<string, TakeLibraryEntry>();
    const removeRepairPath = (fileName: string) => {
      try {
        rmSync(path.join(this.options.directory, fileName), { force: true });
        names.delete(fileName);
        return true;
      } catch {
        // Recovery cleanup is maintenance, not read authority. A read-only/full
        // directory may leave stale repair paths in place without hiding a
        // validated WAV or committed metadata entry.
        return false;
      }
    };

    // A metadata partial without a finalized WAV is an orphan after restart,
    // but the current process deliberately stages rich metadata before WAV
    // publication. Never let a concurrent history read erase that live stage.
    for (const name of [...names]) {
      const match = TAKE_METADATA_PART_PATTERN.exec(name);
      if (
        !match
        || names.has(`${match[1]}.wav`)
        || this.stagedTakeIds.has(match[1])
      ) continue;
      removeRepairPath(name);
    }

    for (const name of [...names]) {
      const match = TAKE_WAV_PATTERN.exec(name);
      if (!match) continue;
      const takeId = match[1];
      const metadataName = metadataFileName(takeId);
      const metadataPartName = metadataPartFileName(takeId);
      const metadataPath = path.join(this.options.directory, metadataName);
      const metadataPartPath = path.join(this.options.directory, metadataPartName);
      const wavPath = path.join(this.options.directory, name);

      if (names.has(metadataName)) {
        let committed: TakeLibraryEntry | null = null;
        try {
          committed = readValidatedMetadata(
            metadataPath,
            wavPath,
            takeId,
            this.artifactBaseUrl,
            true,
          );
        } catch {}
        if (committed) {
          if (names.has(metadataPartName)) removeRepairPath(metadataPartName);
          continue;
        }
        removeRepairPath(metadataName);
      }

      if (names.has(metadataPartName)) {
        let staged: TakeLibraryEntry | null = null;
        try {
          staged = readValidatedMetadata(
            metadataPartPath,
            wavPath,
            takeId,
            this.artifactBaseUrl,
            true,
          );
        } catch {}
        if (staged) {
          try {
            durableRenameSync(metadataPartPath, metadataPath);
            names.delete(metadataPartName);
            names.add(metadataName);
            continue;
          } catch {
            // A complete staged transaction paired with its validated WAV is
            // readable even when the filesystem cannot persist its promotion.
            recoveryFallbacks.set(takeId, staged);
            continue;
          }
        }
        removeRepairPath(metadataPartName);
      }

      let entry: TakeLibraryEntry;
      try {
        entry = recoveredEntryFromWav(wavPath, takeId, this.artifactBaseUrl);
      } catch {
        // Corrupt or non-Relay WAVs matching the UUID pattern are ignored rather
        // than making the whole recording library unavailable.
        continue;
      }

      try {
        this.writeMetadata(entry);
      } catch {
        // Persisting recovered metadata is a repair optimization, not read
        // authority. If the directory is read-only/full, keep the validated WAV
        // visible for this read instead of misclassifying it as corrupt.
        recoveryFallbacks.set(takeId, entry);
      }
    }

    return recoveryFallbacks;
  }

  private writeMetadataPartial(entry: TakeLibraryEntry) {
    const partialPath = path.join(this.options.directory, metadataPartFileName(entry.takeId));
    const payload: TakeMetadataV1 = { version: 1, take: entry };
    writeFileSync(partialPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flush: true });
  }

  private writeMetadata(entry: TakeLibraryEntry) {
    const finalPath = path.join(this.options.directory, metadataFileName(entry.takeId));
    const partialPath = path.join(this.options.directory, metadataPartFileName(entry.takeId));
    this.writeMetadataPartial(entry);
    durableRenameSync(partialPath, finalPath);
  }
}
