import { randomUUID } from 'node:crypto';

import {
  TakeSession,
  type StopTakeDecision,
  type TakeSongSnapshot,
  type TakeStopReason,
} from './take-session.js';
import {
  prepareTakeStorage,
  pruneTakeArtifacts,
  takeStorageBudget,
  takeStoragePolicyFromEnv,
  type TakeStoragePolicy,
} from './take-storage.js';
import { WavTakeWriter } from './wav-take-writer.js';

export type StartTakeResult =
  | { ok: true; takeId: string }
  | { ok: false; reason: 'take-active' | 'writer-failed' | 'storage-unavailable' };

export type StopTakeResult = StopTakeDecision;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Binds the pure Take lifecycle to the server-side WAV artifact writer.
 *
 * It deliberately knows nothing about Mic ownership, WebSockets, SongSession
 * authority or product UI. The transport layer decides whether a Start/Stop
 * request is allowed, while this controller guarantees one room recording and
 * one writer/finalization path at a time.
 */
export class TakeController {
  private readonly session = new TakeSession();
  private readonly storagePolicy: TakeStoragePolicy;
  private writer: WavTakeWriter | null = null;
  private storagePrepared = false;
  private pruneChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    directory: string;
    sampleRate: number;
    artifactBaseUrl?: string;
    storagePolicy?: TakeStoragePolicy;
    onChange?: (status: ReturnType<TakeSession['statusPayload']>) => void;
    onStorageError?: (error: unknown) => void;
  }) {
    this.storagePolicy = options.storagePolicy ?? takeStoragePolicyFromEnv();
    try {
      prepareTakeStorage(this.options.directory, this.storagePolicy);
      this.storagePrepared = true;
    } catch (error) {
      // Keep the server alive so diagnostics and existing non-Take features
      // still work; Start will retry the storage preparation and reject clearly
      // if the directory or free-space reserve is still unavailable.
      this.reportStorageError(error);
    }
  }

  get lifecycle() {
    return this.session.lifecycle;
  }

  get recordingTakeId() {
    return this.session.recordingTakeId;
  }

  statusPayload() {
    return this.session.statusPayload();
  }

  start(actorParticipantId: string, song: TakeSongSnapshot, nowMs = Date.now()): StartTakeResult {
    if (this.session.lifecycle === 'recording' || this.session.lifecycle === 'finalizing') {
      return { ok: false, reason: 'take-active' };
    }

    let maxTakeDataBytes: number;
    try {
      if (!this.storagePrepared) {
        const prepared = prepareTakeStorage(this.options.directory, this.storagePolicy, nowMs);
        this.storagePrepared = true;
        maxTakeDataBytes = prepared.maxTakeDataBytes;
      } else {
        maxTakeDataBytes = takeStorageBudget(this.options.directory, this.storagePolicy);
      }
    } catch (error) {
      this.reportStorageError(error);
      return { ok: false, reason: 'storage-unavailable' };
    }

    const takeId = randomUUID();
    const started = this.session.start({
      takeId,
      startedByParticipantId: actorParticipantId,
      song,
      startedAtMs: nowMs,
    });
    if (!started.ok) return started;

    let writer: WavTakeWriter | null = null;
    try {
      const createdWriter = new WavTakeWriter({
        directory: this.options.directory,
        takeId,
        sampleRate: this.options.sampleRate,
        maxDataBytes: maxTakeDataBytes,
        onError: (error) => {
          // Deferring makes this safe even if a future writer implementation
          // invokes its error callback synchronously during construction.
          queueMicrotask(() => {
            if (writer) this.failWriter(writer, error);
          });
        },
      });
      writer = createdWriter;
    } catch (error) {
      this.session.fail(takeId, errorMessage(error), Date.now());
      this.emitChange();
      return { ok: false, reason: 'writer-failed' };
    }

    this.writer = writer;
    this.emitChange();
    return { ok: true, takeId };
  }

  stop(
    takeId: string,
    actorParticipantId: string | null,
    stopReason: TakeStopReason = 'user',
    nowMs = Date.now(),
  ): StopTakeResult {
    const decision = this.session.beginFinalizing({
      takeId,
      stoppedByParticipantId: actorParticipantId,
      stopReason,
      endedAtMs: nowMs,
    });
    if (!decision.ok || decision.duplicate) return decision;

    const writer = this.writer;
    this.writer = null;
    this.emitChange();

    if (!writer || writer.takeId !== takeId) {
      this.session.fail(takeId, 'Take WAV writer was not available during finalization.', Date.now());
      this.emitChange();
      return decision;
    }

    void writer.finalize()
      .then((file) => {
        const base = this.options.artifactBaseUrl ?? '/takes';
        const completed = this.session.complete(takeId, {
          fileName: file.fileName,
          url: `${base}/${encodeURIComponent(takeId)}.wav`,
          mimeType: 'audio/wav',
          sizeBytes: file.sizeBytes,
          sampleRate: file.sampleRate,
          channels: 1,
          bitsPerSample: 16,
          sampleCount: file.sampleCount,
          durationMs: file.durationMs,
        });
        if (completed) {
          this.emitChange();
          this.scheduleRetentionPrune();
        } else {
          // A finalized file without a matching ready Take is not a valid
          // artifact and must not become an unreferenced disk leak.
          void writer.discardFinalized();
        }
      })
      .catch((error) => {
        if (this.session.fail(takeId, errorMessage(error), Date.now())) this.emitChange();
        void writer.abort();
      });

    return decision;
  }

  endMix(nowMs = Date.now()) {
    const takeId = this.session.recordingTakeId;
    if (!takeId) return false;
    const result = this.stop(takeId, null, 'mix-ended', nowMs);
    return result.ok;
  }

  append(frame: Buffer) {
    const writer = this.writer;
    if (!writer || this.session.recordingTakeId !== writer.takeId) return false;
    try {
      writer.append(frame);
      return true;
    } catch (error) {
      this.failWriter(writer, error);
      return false;
    }
  }

  shutdown() {
    const writer = this.writer;
    this.writer = null;
    if (writer) void writer.abort();
  }

  private failWriter(writer: WavTakeWriter, error: unknown) {
    if (this.writer !== writer) return;
    this.writer = null;
    if (this.session.fail(writer.takeId, errorMessage(error), Date.now())) this.emitChange();
    void writer.abort();
  }

  private scheduleRetentionPrune() {
    this.pruneChain = this.pruneChain
      .then(async () => {
        const current = this.session.currentTake();
        const preserveFileName = current ? `${current.takeId}.wav` : null;
        await pruneTakeArtifacts(
          this.options.directory,
          this.storagePolicy,
          preserveFileName,
        );
      })
      .catch((error) => {
        this.reportStorageError(error);
      });
  }

  private reportStorageError(error: unknown) {
    if (this.options.onStorageError) {
      this.options.onStorageError(error);
      return;
    }
    console.error(`Take storage error: ${errorMessage(error)}`);
  }

  private emitChange() {
    this.options.onChange?.(this.session.statusPayload());
  }
}

export type { TakeSongSnapshot };
