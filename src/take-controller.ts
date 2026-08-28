import { randomUUID } from 'node:crypto';

import type { MixFrameEvidence, MixFramePosition } from './audio-session.js';
import { TakeLibrary, type TakeLibraryEntry } from './take-library.js';
import {
  TakeQualityTracker,
  type TakeQualityEventKind,
  type TakeQualityFrameState,
  type TakeQualityVerdict,
} from './take-quality.js';
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
  | {
    ok: false;
    reason: 'take-active' | 'writer-failed' | 'storage-unavailable' | 'mix-boundary-invalid';
  };

export type StopTakeResult = StopTakeDecision | { ok: false; reason: 'mix-boundary-invalid' };

/**
 * Product-facing recording history. Durable library metadata is intentionally
 * richer than this browser contract: participant ids, stop reasons and full
 * quality evidence remain server/storage concerns until a product surface
 * explicitly needs them.
 */
export type TakeHistoryItem = {
  takeId: string;
  endedAtMs: number;
  songVideoId: string | null;
  artifact: {
    url: string;
    durationMs: number;
  };
  qualityVerdict: TakeQualityVerdict | null;
  recovered: boolean;
};

export type TakeControllerStatusPayload = ReturnType<TakeSession['statusPayload']> & {
  history: readonly TakeHistoryItem[];
};

type PendingStop = {
  takeId: string;
  actorParticipantId: string | null;
  stopReason: TakeStopReason;
  stopPosition: MixFramePosition;
  endedAtMs: number;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function validMixPosition(position: MixFramePosition) {
  return Number.isSafeInteger(position.generation)
    && position.generation >= 0
    && Number.isSafeInteger(position.firstSampleIndex)
    && position.firstSampleIndex >= 0;
}

function historyItem(entry: TakeLibraryEntry): TakeHistoryItem {
  return {
    takeId: entry.takeId,
    endedAtMs: entry.endedAtMs,
    songVideoId: entry.song?.videoId ?? null,
    artifact: {
      url: entry.artifact.url,
      durationMs: entry.artifact.durationMs,
    },
    qualityVerdict: entry.quality?.verdict ?? null,
    recovered: entry.recovered,
  };
}

function sameHistoryItem(a: TakeHistoryItem | undefined, b: TakeHistoryItem) {
  return Boolean(
    a
    && a.takeId === b.takeId
    && a.endedAtMs === b.endedAtMs
    && a.songVideoId === b.songVideoId
    && a.artifact.url === b.artifact.url
    && a.artifact.durationMs === b.artifact.durationMs
    && a.qualityVerdict === b.qualityVerdict
    && a.recovered === b.recovered,
  );
}

/**
 * Binds the pure Take lifecycle to the server-side WAV artifact writer, storage
 * policy, durable recording library and one Take-scoped quality tracker.
 *
 * It deliberately knows nothing about Mic ownership, WebSockets, SongSession
 * authority or product UI. AudioSession supplies exact evidence and position
 * beside each mixed PCM frame; this controller commits both only after the same
 * frame is accepted by the WAV writer.
 *
 * Start and Stop are armed against full-frame MixFramePositions. Because the
 * live mixer intentionally emits prebuffered audio, a command may arrive
 * hundreds of milliseconds before its addressed frame reaches this boundary.
 * Frames before Start are ignored and a Stop remains pending until the final
 * included frame has crossed the writer, so command scheduling never changes
 * which authoritative samples land in the WAV.
 */
export class TakeController {
  private readonly session = new TakeSession();
  private readonly storagePolicy: TakeStoragePolicy;
  private readonly library: TakeLibrary;
  private historyCache: readonly TakeHistoryItem[] = [];
  private writer: WavTakeWriter | null = null;
  private quality: TakeQualityTracker | null = null;
  private pendingStop: PendingStop | null = null;
  private storagePrepared = false;
  private pruneChain: Promise<void> = Promise.resolve();
  private finalization: Promise<void> | null = null;

  constructor(private readonly options: {
    directory: string;
    sampleRate: number;
    artifactBaseUrl?: string;
    storagePolicy?: TakeStoragePolicy;
    onChange?: (status: TakeControllerStatusPayload) => void;
    onStorageError?: (error: unknown) => void;
  }) {
    this.storagePolicy = options.storagePolicy ?? takeStoragePolicyFromEnv();
    this.library = new TakeLibrary({
      directory: options.directory,
      artifactBaseUrl: options.artifactBaseUrl,
    });
    try {
      prepareTakeStorage(this.options.directory, this.storagePolicy);
      this.library.prepare();
      this.refreshHistoryCache();
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

  statusPayload(): TakeControllerStatusPayload {
    return {
      ...this.session.statusPayload(),
      // This is a product-shaped memory snapshot. Product status asks for Take
      // state on normal Live updates, so status delivery must never rescan the
      // SD card or expose durable-library internals by accident.
      history: this.historyCache,
    };
  }

  listHistory() {
    const history = this.library.list();
    this.replaceHistoryCache(history);
    return history;
  }

  historyEntry(takeId: string) {
    return this.library.get(takeId);
  }

  start(
    actorParticipantId: string,
    song: TakeSongSnapshot,
    startPosition: MixFramePosition,
    nowMs = Date.now(),
  ): StartTakeResult {
    if (this.session.lifecycle === 'recording' || this.session.lifecycle === 'finalizing') {
      return { ok: false, reason: 'take-active' };
    }
    if (!validMixPosition(startPosition)) {
      return { ok: false, reason: 'mix-boundary-invalid' };
    }

    let maxTakeDataBytes: number;
    try {
      if (!this.storagePrepared) {
        const prepared = prepareTakeStorage(this.options.directory, this.storagePolicy, nowMs);
        this.library.prepare();
        this.refreshHistoryCache();
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
      startPosition,
      startedAtMs: nowMs,
    });
    if (!started.ok) return started;

    const backingExpected = song.videoId !== null;
    this.quality = new TakeQualityTracker({
      sampleRate: this.options.sampleRate,
      backingExpected,
      timingExpected: backingExpected,
    });
    this.pendingStop = null;

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
      const quality = this.quality.assessment();
      this.quality = null;
      this.session.fail(takeId, errorMessage(error), Date.now(), quality);
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
    stopPosition: MixFramePosition,
    stopReason: TakeStopReason = 'user',
    nowMs = Date.now(),
  ): StopTakeResult {
    const current = this.session.currentTake();
    if (!current) return { ok: false, reason: 'take-not-recording' };
    if (current.takeId !== takeId) return { ok: false, reason: 'stale-take' };

    if (current.lifecycle !== 'recording') {
      return { ok: true, take: current, duplicate: true };
    }
    if (this.pendingStop?.takeId === takeId) {
      return { ok: true, take: current, duplicate: true };
    }

    const range = current.mixSampleRange;
    if (
      !range
      || !validMixPosition(stopPosition)
      || stopPosition.generation !== range.generation
      || stopPosition.firstSampleIndex < range.endSampleIndex
    ) {
      return { ok: false, reason: 'mix-boundary-invalid' };
    }

    const request: PendingStop = {
      takeId,
      actorParticipantId,
      stopReason,
      stopPosition: { ...stopPosition },
      endedAtMs: nowMs,
    };
    this.pendingStop = request;

    // Rapid Start/Stop (or a command exactly at the already-written frontier)
    // needs no future audio to resolve. Finalize the zero/full-frame window now.
    if (stopPosition.firstSampleIndex === range.endSampleIndex) {
      return this.finalizeStop(request);
    }

    // The Stop command is accepted now, but the prebuffered mixer has not
    // reached its addressed boundary yet. Keep the recording lifecycle active
    // until every frame strictly before the exclusive boundary is committed.
    return { ok: true, take: current, duplicate: false };
  }

  endMix(nowMs = Date.now()) {
    return this.finalizeAtCurrentFrontier('mix-ended', nowMs);
  }

  append(
    frame: Buffer,
    state: TakeQualityFrameState,
    evidence: MixFrameEvidence,
    position: MixFramePosition,
  ) {
    const writer = this.writer;
    const current = this.session.currentTake();
    if (!writer || !current || current.lifecycle !== 'recording' || current.takeId !== writer.takeId) {
      return false;
    }

    const range = current.mixSampleRange;
    if (!range) {
      this.failWriter(writer, new Error('Take recording window is missing its Start boundary.'));
      return false;
    }
    if (position.generation !== range.generation) {
      this.failWriter(writer, new Error('Take mix generation changed before the recording boundary completed.'));
      return false;
    }

    // The mixer emits prebuffered audio. A successful Start addresses a frame
    // on the live session clock, so older frames can continue to drain for a
    // while and must not leak into the WAV.
    if (position.firstSampleIndex < range.startSampleIndex) return false;

    const pendingStop = this.pendingStop;
    if (
      pendingStop
      && position.firstSampleIndex >= pendingStop.stopPosition.firstSampleIndex
    ) {
      this.finalizeStop(pendingStop);
      return false;
    }

    try {
      writer.append(frame);
      const sampleCount = Math.floor(frame.byteLength / 2);
      if (!this.session.appendMixFrame(position, sampleCount)) {
        throw new Error('Take lifecycle rejected an accepted mix frame.');
      }
      this.quality?.observeFrame(sampleCount, state, evidence);

      if (pendingStop) {
        const frameEndSampleIndex = position.firstSampleIndex + sampleCount;
        if (frameEndSampleIndex > pendingStop.stopPosition.firstSampleIndex) {
          throw new Error('Take Stop boundary would require cutting a mixed frame.');
        }
        if (frameEndSampleIndex === pendingStop.stopPosition.firstSampleIndex) {
          this.finalizeStop(pendingStop);
        }
      }
      return true;
    } catch (error) {
      this.failWriter(writer, error);
      return false;
    }
  }

  noteQualityEvent(kind: TakeQualityEventKind) {
    if (!this.session.recordingTakeId) return false;
    this.quality?.noteEvent(kind);
    return true;
  }

  async shutdown(nowMs = Date.now()) {
    if (this.session.recordingTakeId) {
      this.quality?.noteEvent('server-shutdown');
      this.finalizeAtCurrentFrontier('server-shutdown', nowMs);
    }

    const finalization = this.finalization;
    if (finalization) await finalization;

    // A normal recording/finalizing Take has been drained above. This only
    // covers an impossible lifecycle mismatch or a writer that failed before
    // the Take could enter finalizing.
    const orphanWriter = this.writer;
    this.writer = null;
    this.quality = null;
    this.pendingStop = null;
    if (orphanWriter) await orphanWriter.abort();
    await this.pruneChain;
  }

  private finalizeAtCurrentFrontier(
    stopReason: 'mix-ended' | 'server-shutdown',
    nowMs: number,
  ) {
    const current = this.session.currentTake();
    if (!current || current.lifecycle !== 'recording' || !current.mixSampleRange) return false;

    // Once no later mix frame can be accepted, the only truthful boundary is
    // the writer frontier already committed to this Take. Never invent silence
    // to reach a previously armed command boundary.
    const request: PendingStop = {
      takeId: current.takeId,
      actorParticipantId: null,
      stopReason,
      stopPosition: {
        generation: current.mixSampleRange.generation,
        firstSampleIndex: current.mixSampleRange.endSampleIndex,
      },
      endedAtMs: nowMs,
    };
    this.pendingStop = request;
    return this.finalizeStop(request).ok;
  }

  private finalizeStop(request: PendingStop): StopTakeResult {
    if (this.pendingStop !== request) {
      const current = this.session.currentTake();
      if (current?.takeId === request.takeId) {
        return { ok: true, take: current, duplicate: true };
      }
      return { ok: false, reason: current ? 'stale-take' : 'take-not-recording' };
    }

    const current = this.session.currentTake();
    const quality = this.quality?.assessment() ?? current?.quality;
    if (!quality) {
      return current?.takeId === request.takeId
        ? { ok: false, reason: 'take-not-recording' }
        : { ok: false, reason: current ? 'stale-take' : 'take-not-recording' };
    }

    let decision: StopTakeDecision;
    try {
      decision = this.session.beginFinalizing({
        takeId: request.takeId,
        stoppedByParticipantId: request.actorParticipantId,
        stopReason: request.stopReason,
        stopPosition: request.stopPosition,
        endedAtMs: request.endedAtMs,
        quality,
      });
    } catch (error) {
      const writer = this.writer;
      if (writer) this.failWriter(writer, error);
      return { ok: false, reason: 'mix-boundary-invalid' };
    }
    if (!decision.ok || decision.duplicate) {
      this.pendingStop = null;
      return decision;
    }

    const writer = this.writer;
    this.writer = null;
    this.quality = null;
    this.pendingStop = null;
    this.emitChange();

    if (!writer || writer.takeId !== request.takeId) {
      this.session.fail(
        request.takeId,
        'Take WAV writer was not available during finalization.',
        Date.now(),
      );
      this.emitChange();
      return decision;
    }

    const finalization = this.finalizeWriter(writer, request.takeId);
    this.finalization = finalization;
    void finalization.finally(() => {
      if (this.finalization === finalization) this.finalization = null;
    });

    return decision;
  }

  private async finalizeWriter(writer: WavTakeWriter, takeId: string) {
    try {
      const file = await writer.finalize();
      const pendingTake = this.session.currentTake();
      const recordedSampleCount = pendingTake?.mixSampleRange?.sampleCount ?? 0;
      if (recordedSampleCount !== file.sampleCount) {
        if (this.session.fail(
          takeId,
          `Take sample metadata recorded ${recordedSampleCount} samples but WAV contains ${file.sampleCount}.`,
          Date.now(),
        )) this.emitChange();
        await writer.discardFinalized();
        return;
      }

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
        const readyTake = this.session.currentTake();
        if (readyTake?.lifecycle === 'ready' && readyTake.artifact) {
          try {
            const item = historyItem(this.library.record(readyTake));
            this.historyCache = Object.freeze([
              structuredClone(item),
              ...this.historyCache
                .filter((candidate) => candidate.takeId !== item.takeId)
                .map((candidate) => structuredClone(candidate)),
            ]);
          } catch (error) {
            // The finalized WAV remains authoritative and recoverable. A
            // metadata failure must not turn a successfully recorded Take
            // into a failed one; the browser receives the ready Take beside
            // the last durable history snapshot and can review it now.
            this.reportStorageError(error);
          }
        }
        this.emitChange();
        this.scheduleRetentionPrune();
      } else {
        // A finalized file without a matching ready Take is not a valid
        // artifact and must not become an unreferenced disk leak.
        await writer.discardFinalized();
      }
    } catch (error) {
      if (this.session.fail(takeId, errorMessage(error), Date.now())) this.emitChange();
      await writer.abort();
    }
  }

  private failWriter(writer: WavTakeWriter, error: unknown) {
    if (this.writer !== writer) return;
    this.writer = null;
    this.pendingStop = null;
    const quality = this.quality?.assessment();
    this.quality = null;
    if (this.session.fail(writer.takeId, errorMessage(error), Date.now(), quality)) this.emitChange();
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
        if (this.refreshHistoryCache()) this.emitChange();
      })
      .catch((error) => {
        this.reportStorageError(error);
      });
  }

  private refreshHistoryCache() {
    const nextItems = this.library.list().map(historyItem);
    const changed = nextItems.length !== this.historyCache.length
      || nextItems.some((entry, index) => !sameHistoryItem(this.historyCache[index], entry));
    this.historyCache = Object.freeze(nextItems.map((entry) => structuredClone(entry)));
    return changed;
  }

  private replaceHistoryCache(history: readonly TakeLibraryEntry[]) {
    this.historyCache = Object.freeze(history.map((entry) => structuredClone(historyItem(entry))));
  }

  private reportStorageError(error: unknown) {
    if (this.options.onStorageError) {
      this.options.onStorageError(error);
      return;
    }
    console.error(`Take storage error: ${errorMessage(error)}`);
  }

  private emitChange() {
    this.options.onChange?.(this.statusPayload());
  }
}

export type { TakeSongSnapshot };
