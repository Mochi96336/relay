import { randomUUID } from 'node:crypto';

import type { MixFrameEvidence } from './audio-session.js';
import {
  TakeQualityTracker,
  type TakeQualityEventKind,
  type TakeQualityFrameState,
} from './take-quality.js';
import {
  TakeSession,
  type StopTakeDecision,
  type TakeSongSnapshot,
  type TakeStopReason,
} from './take-session.js';
import { WavTakeWriter } from './wav-take-writer.js';

export type StartTakeResult =
  | { ok: true; takeId: string }
  | { ok: false; reason: 'take-active' | 'writer-failed' };

export type StopTakeResult = StopTakeDecision;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Binds the pure Take lifecycle to the server-side WAV artifact writer and one
 * Take-scoped quality tracker.
 *
 * It deliberately knows nothing about Mic ownership, WebSockets, SongSession
 * authority or product UI. AudioSession supplies exact evidence beside each
 * mixed PCM frame; this controller guarantees that evidence reaches the Take
 * only after the same frame is accepted by the WAV writer.
 */
export class TakeController {
  private readonly session = new TakeSession();
  private writer: WavTakeWriter | null = null;
  private quality: TakeQualityTracker | null = null;

  constructor(private readonly options: {
    directory: string;
    sampleRate: number;
    artifactBaseUrl?: string;
    onChange?: (status: ReturnType<TakeSession['statusPayload']>) => void;
  }) {}

  get lifecycle() {
    return this.session.lifecycle;
  }

  get recordingTakeId() {
    return this.session.recordingTakeId;
  }

  statusPayload() {
    return this.session.statusPayload();
  }

  start(
    actorParticipantId: string,
    song: TakeSongSnapshot,
    nowMs = Date.now(),
  ): StartTakeResult {
    const takeId = randomUUID();
    const started = this.session.start({
      takeId,
      startedByParticipantId: actorParticipantId,
      song,
      startedAtMs: nowMs,
    });
    if (!started.ok) return started;

    this.quality = new TakeQualityTracker({ sampleRate: this.options.sampleRate });

    let writer: WavTakeWriter;
    try {
      writer = new WavTakeWriter({
        directory: this.options.directory,
        takeId,
        sampleRate: this.options.sampleRate,
        onError: (error) => this.failWriter(writer, error),
      });
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
    stopReason: TakeStopReason = 'user',
    nowMs = Date.now(),
  ): StopTakeResult {
    const current = this.session.currentTake();
    const quality = this.quality?.assessment() ?? current?.quality;
    if (!quality) {
      return current?.takeId === takeId
        ? { ok: false, reason: 'take-not-recording' }
        : { ok: false, reason: current ? 'stale-take' : 'take-not-recording' };
    }

    const decision = this.session.beginFinalizing({
      takeId,
      stoppedByParticipantId: actorParticipantId,
      stopReason,
      endedAtMs: nowMs,
      quality,
    });
    if (!decision.ok || decision.duplicate) return decision;

    const writer = this.writer;
    this.writer = null;
    this.quality = null;
    this.emitChange();

    if (!writer || writer.takeId !== takeId) {
      this.session.fail(takeId, 'Take WAV writer was not available during finalization.', Date.now());
      this.emitChange();
      return decision;
    }

    void writer.finalize()
      .then((file) => {
        const base = this.options.artifactBaseUrl ?? '/takes';
        if (this.session.complete(takeId, {
          fileName: file.fileName,
          url: `${base}/${encodeURIComponent(takeId)}.wav`,
          mimeType: 'audio/wav',
          sizeBytes: file.sizeBytes,
          sampleRate: file.sampleRate,
          channels: 1,
          bitsPerSample: 16,
          sampleCount: file.sampleCount,
          durationMs: file.durationMs,
        })) this.emitChange();
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

  append(frame: Buffer, state: TakeQualityFrameState, evidence: MixFrameEvidence) {
    const writer = this.writer;
    if (!writer || this.session.recordingTakeId !== writer.takeId) return false;
    try {
      writer.append(frame);
      this.quality?.observeFrame(Math.floor(frame.byteLength / 2), state, evidence);
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

  shutdown() {
    const writer = this.writer;
    this.writer = null;
    this.quality = null;
    if (writer) void writer.abort();
  }

  private failWriter(writer: WavTakeWriter, error: unknown) {
    if (this.writer !== writer) return;
    this.writer = null;
    const quality = this.quality?.assessment();
    this.quality = null;
    if (this.session.fail(writer.takeId, errorMessage(error), Date.now(), quality)) this.emitChange();
    void writer.abort();
  }

  private emitChange() {
    this.options.onChange?.(this.session.statusPayload());
  }
}

export type { TakeSongSnapshot };
