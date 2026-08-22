import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type {
  TakeArtifact,
  TakeMixSampleRange,
  TakeRecord,
  TakeSongSnapshot,
  TakeStopReason,
} from './take-session.js';
import type { TakeQualityAssessment } from './take-quality.js';

const WAV_HEADER_BYTES = 44;
const TAKE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAKE_WAV_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.wav$/i;
const TAKE_METADATA_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;

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

function isTakeLibraryEntry(value: unknown): value is TakeLibraryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<TakeLibraryEntry>;
  if (typeof entry.takeId !== 'string' || !TAKE_ID_PATTERN.test(entry.takeId)) return false;
  if (!finiteNumber(entry.startedAtMs) || !finiteNumber(entry.endedAtMs)) return false;
  if (entry.startedByParticipantId !== null && typeof entry.startedByParticipantId !== 'string') return false;
  if (entry.stoppedByParticipantId !== null && typeof entry.stoppedByParticipantId !== 'string') return false;
  if (!entry.artifact || typeof entry.artifact !== 'object') return false;
  if (entry.artifact.fileName !== `${entry.takeId}.wav`) return false;
  if (entry.artifact.mimeType !== 'audio/wav') return false;
  if (!finiteNumber(entry.artifact.durationMs) || !finiteNumber(entry.artifact.sampleCount)) return false;
  if (!finiteNumber(entry.artifact.sampleRate) || !finiteNumber(entry.artifact.sizeBytes)) return false;
  return entry.artifact.channels === 1 && entry.artifact.bitsPerSample === 16;
}

function parseMetadata(bytes: Buffer, expectedTakeId: string) {
  const decoded = JSON.parse(bytes.toString('utf8')) as Partial<TakeMetadataV1>;
  if (decoded.version !== 1 || !isTakeLibraryEntry(decoded.take)) return null;
  if (decoded.take.takeId !== expectedTakeId) return null;

  const rawRange = (decoded.take as TakeLibraryEntry & { mixSampleRange?: unknown }).mixSampleRange;
  if (rawRange !== undefined && rawRange !== null && !isTakeMixSampleRange(rawRange)) return null;
  return {
    ...decoded.take,
    mixSampleRange: rawRange && isTakeMixSampleRange(rawRange) ? { ...rawRange } : null,
  } satisfies TakeLibraryEntry;
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

  const audioFormat = header.readUInt16LE(20);
  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const bitsPerSample = header.readUInt16LE(34);
  const dataBytes = header.readUInt32LE(40);
  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate <= 0) {
    throw new Error('Take WAV format is unsupported.');
  }
  const info = statSync(filePath);
  const availableDataBytes = Math.max(0, info.size - WAV_HEADER_BYTES);
  const trustedDataBytes = Math.min(dataBytes, availableDataBytes);
  const sampleCount = Math.floor(trustedDataBytes / 2);
  return {
    fileName: `${takeId}.wav`,
    url: artifactUrl(baseUrl, takeId),
    mimeType: 'audio/wav',
    sizeBytes: info.size,
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    sampleCount,
    durationMs: Math.round((sampleCount * 1000) / sampleRate),
  };
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

  constructor(private readonly options: { directory: string; artifactBaseUrl?: string }) {
    this.artifactBaseUrl = options.artifactBaseUrl ?? '/takes';
  }

  prepare() {
    mkdirSync(this.options.directory, { recursive: true });
    this.recoverLegacyArtifacts();
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

    const entry: TakeLibraryEntry = {
      takeId: take.takeId,
      startedAtMs: take.startedAtMs,
      endedAtMs: take.endedAtMs,
      startedByParticipantId: take.startedByParticipantId,
      stoppedByParticipantId: take.stoppedByParticipantId,
      stopReason: take.stopReason,
      song: { ...take.song },
      artifact: { ...take.artifact },
      mixSampleRange: take.mixSampleRange ? { ...take.mixSampleRange } : null,
      quality: take.quality ? structuredClone(take.quality) : null,
      recovered: false,
    };
    this.writeMetadata(entry);
    return cloneEntry(entry);
  }

  list() {
    mkdirSync(this.options.directory, { recursive: true });
    this.recoverLegacyArtifacts();
    const entries: TakeLibraryEntry[] = [];
    const names = new Set(readdirSync(this.options.directory));

    for (const item of readdirSync(this.options.directory, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const match = TAKE_METADATA_PATTERN.exec(item.name);
      if (!match) continue;
      const takeId = match[1];
      if (!names.has(`${takeId}.wav`)) continue;
      try {
        const metadata = parseMetadata(
          readFileSync(path.join(this.options.directory, item.name)),
          takeId,
        );
        if (metadata) entries.push(metadata);
      } catch {
        // A malformed sidecar must not hide a valid WAV. Recovery below rewrites
        // it on the next pass after this invalid metadata is removed.
      }
    }

    return entries
      .sort((a, b) => b.endedAtMs - a.endedAtMs)
      .map(cloneEntry);
  }

  get(takeId: string) {
    if (!TAKE_ID_PATTERN.test(takeId)) return null;
    mkdirSync(this.options.directory, { recursive: true });
    this.recoverLegacyArtifacts();
    const metadataPath = path.join(this.options.directory, metadataFileName(takeId));
    try {
      const entry = parseMetadata(readFileSync(metadataPath), takeId);
      return entry ? cloneEntry(entry) : null;
    } catch {
      return null;
    }
  }

  remove(takeId: string) {
    if (!TAKE_ID_PATTERN.test(takeId)) return false;
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
    for (const name of names) {
      const match = TAKE_WAV_PATTERN.exec(name);
      if (!match) continue;
      const takeId = match[1];
      const metadataName = metadataFileName(takeId);
      if (names.has(metadataName)) {
        try {
          if (parseMetadata(readFileSync(path.join(this.options.directory, metadataName)), takeId)) continue;
        } catch {}
        rmSync(path.join(this.options.directory, metadataName), { force: true });
      }

      try {
        const wavPath = path.join(this.options.directory, name);
        const artifact = readWavArtifact(wavPath, takeId, this.artifactBaseUrl);
        const endedAtMs = statSync(wavPath).mtimeMs;
        const entry: TakeLibraryEntry = {
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
        this.writeMetadata(entry);
      } catch {
        // Corrupt or non-Relay WAVs matching the UUID pattern are ignored rather
        // than making the whole recording library unavailable.
      }
    }
  }

  private writeMetadata(entry: TakeLibraryEntry) {
    const finalPath = path.join(this.options.directory, metadataFileName(entry.takeId));
    const partialPath = path.join(this.options.directory, metadataPartFileName(entry.takeId));
    const payload: TakeMetadataV1 = { version: 1, take: entry };
    writeFileSync(partialPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8' });
    renameSync(partialPath, finalPath);
  }
}
