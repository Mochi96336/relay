import type { MixFramePosition } from './audio-session.js';
import type { TakeQualityAssessment } from './take-quality.js';

export type TakeLifecycle = 'idle' | 'recording' | 'finalizing' | 'ready' | 'failed';

export type TakeStopReason = 'user' | 'mix-ended';

export type TakeSongSnapshot = {
  // Null is an intentional voice-only Take, not a missing required field.
  videoId: string | null;
  revision: number | null;
  state: number | null;
  serverTime: number | null;
  playbackRate: number | null;
};

export type TakeArtifact = {
  fileName: string;
  url: string;
  mimeType: 'audio/wav';
  sizeBytes: number;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  sampleCount: number;
  durationMs: number;
};

/**
 * Authoritative address of the mixed PCM written into one Take.
 *
 * `endSampleIndex` is exclusive. `sampleCount` is the number of PCM samples
 * actually accepted by the WAV writer; it can be smaller than
 * `endSampleIndex - startSampleIndex` if an upstream caller ever presents a
 * positioned hole. Keeping both prevents durable metadata from compressing a
 * real timeline gap while still allowing the artifact sample count to be
 * checked exactly.
 */
export type TakeMixSampleRange = {
  generation: number;
  startSampleIndex: number;
  endSampleIndex: number;
  sampleCount: number;
};

export type TakeRecord = {
  takeId: string;
  lifecycle: Exclude<TakeLifecycle, 'idle'>;
  startedAtMs: number;
  endedAtMs: number | null;
  startedByParticipantId: string;
  stoppedByParticipantId: string | null;
  stopReason: TakeStopReason | null;
  song: TakeSongSnapshot;
  artifact: TakeArtifact | null;
  mixSampleRange: TakeMixSampleRange | null;
  quality: TakeQualityAssessment | null;
  error: string | null;
};

export type StartTakeDecision =
  | { ok: true; take: TakeRecord }
  | { ok: false; reason: 'take-active' };

export type StopTakeDecision =
  | { ok: true; take: TakeRecord; duplicate: boolean }
  | { ok: false; reason: 'take-not-recording' | 'stale-take' };

function cloneSong(song: TakeSongSnapshot): TakeSongSnapshot {
  return { ...song };
}

function cloneArtifact(artifact: TakeArtifact | null): TakeArtifact | null {
  return artifact ? { ...artifact } : null;
}

function cloneMixSampleRange(range: TakeMixSampleRange | null): TakeMixSampleRange | null {
  return range ? { ...range } : null;
}

function cloneQuality(quality: TakeQualityAssessment | null): TakeQualityAssessment | null {
  if (!quality) return null;
  return {
    ...quality,
    evidence: {
      ...quality.evidence,
      events: { ...quality.evidence.events },
    },
    issues: quality.issues.map((issue) => ({ ...issue })),
  };
}

function cloneTake(take: TakeRecord): TakeRecord {
  return {
    ...take,
    song: cloneSong(take.song),
    artifact: cloneArtifact(take.artifact),
    mixSampleRange: cloneMixSampleRange(take.mixSampleRange),
    quality: cloneQuality(take.quality),
  };
}

function assertFrameAddress(position: MixFramePosition, sampleCount: number) {
  if (!Number.isSafeInteger(position.generation) || position.generation < 0) {
    throw new Error('Take mix generation is invalid.');
  }
  if (!Number.isSafeInteger(position.firstSampleIndex) || position.firstSampleIndex < 0) {
    throw new Error('Take mix sample position is invalid.');
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new Error('Take mix frame sample count is invalid.');
  }
  const endSampleIndex = position.firstSampleIndex + sampleCount;
  if (!Number.isSafeInteger(endSampleIndex)) {
    throw new Error('Take mix sample range exceeds the safe integer range.');
  }
  return endSampleIndex;
}

/**
 * Room-owned recording lifecycle.
 *
 * A Take deliberately has no microphone-owner field. Person/Mic authority may
 * change while a Take is recording; that is a room event, not a reason to split
 * the recording. The server binds this lifecycle to one authoritative mixed-PCM
 * output and supplies the file artifact when that output has been finalized.
 */
export class TakeSession {
  private current: TakeRecord | null = null;

  get lifecycle(): TakeLifecycle {
    return this.current?.lifecycle ?? 'idle';
  }

  get takeId() {
    return this.current?.takeId ?? null;
  }

  get recordingTakeId() {
    return this.current?.lifecycle === 'recording' ? this.current.takeId : null;
  }

  get finalizingTakeId() {
    return this.current?.lifecycle === 'finalizing' ? this.current.takeId : null;
  }

  start(input: {
    takeId: string;
    startedByParticipantId: string;
    song: TakeSongSnapshot;
    startedAtMs: number;
  }): StartTakeDecision {
    if (this.current?.lifecycle === 'recording' || this.current?.lifecycle === 'finalizing') {
      return { ok: false, reason: 'take-active' };
    }

    this.current = {
      takeId: input.takeId,
      lifecycle: 'recording',
      startedAtMs: input.startedAtMs,
      endedAtMs: null,
      startedByParticipantId: input.startedByParticipantId,
      stoppedByParticipantId: null,
      stopReason: null,
      song: cloneSong(input.song),
      artifact: null,
      mixSampleRange: null,
      quality: null,
      error: null,
    };
    return { ok: true, take: cloneTake(this.current) };
  }

  /**
   * Commits one writer-accepted output frame into the Take's authoritative
   * sample identity. Forward holes are preserved; overlap, reordering or a
   * generation change would make one Take ambiguous and is rejected.
   */
  appendMixFrame(position: MixFramePosition, sampleCount: number) {
    const take = this.current;
    if (!take || take.lifecycle !== 'recording') return false;

    const endSampleIndex = assertFrameAddress(position, sampleCount);
    const currentRange = take.mixSampleRange;
    if (!currentRange) {
      take.mixSampleRange = {
        generation: position.generation,
        startSampleIndex: position.firstSampleIndex,
        endSampleIndex,
        sampleCount,
      };
      return true;
    }

    if (currentRange.generation !== position.generation) {
      throw new Error('Take mix generation changed while recording.');
    }
    if (position.firstSampleIndex < currentRange.endSampleIndex) {
      throw new Error('Take mix frame position overlapped or moved backwards.');
    }

    const nextSampleCount = currentRange.sampleCount + sampleCount;
    if (!Number.isSafeInteger(nextSampleCount)) {
      throw new Error('Take recorded sample count exceeds the safe integer range.');
    }
    currentRange.endSampleIndex = endSampleIndex;
    currentRange.sampleCount = nextSampleCount;
    return true;
  }

  beginFinalizing(input: {
    takeId: string;
    stoppedByParticipantId: string | null;
    stopReason: TakeStopReason;
    endedAtMs: number;
    quality: TakeQualityAssessment;
  }): StopTakeDecision {
    const take = this.current;
    if (!take) return { ok: false, reason: 'take-not-recording' };
    if (take.takeId !== input.takeId) return { ok: false, reason: 'stale-take' };

    if (take.lifecycle === 'finalizing' || take.lifecycle === 'ready' || take.lifecycle === 'failed') {
      return { ok: true, take: cloneTake(take), duplicate: true };
    }
    if (take.lifecycle !== 'recording') return { ok: false, reason: 'take-not-recording' };

    take.lifecycle = 'finalizing';
    take.endedAtMs = input.endedAtMs;
    take.stoppedByParticipantId = input.stoppedByParticipantId;
    take.stopReason = input.stopReason;
    take.quality = cloneQuality(input.quality);
    return { ok: true, take: cloneTake(take), duplicate: false };
  }

  complete(takeId: string, artifact: TakeArtifact) {
    if (!this.current || this.current.takeId !== takeId || this.current.lifecycle !== 'finalizing') {
      return false;
    }
    this.current.lifecycle = 'ready';
    this.current.artifact = cloneArtifact(artifact);
    this.current.error = null;
    return true;
  }

  fail(takeId: string, error: string, endedAtMs: number, quality?: TakeQualityAssessment) {
    if (!this.current || this.current.takeId !== takeId) return false;
    if (this.current.lifecycle === 'ready' || this.current.lifecycle === 'failed') return false;

    this.current.lifecycle = 'failed';
    this.current.endedAtMs ??= endedAtMs;
    this.current.error = error;
    this.current.artifact = null;
    if (quality) this.current.quality = cloneQuality(quality);
    return true;
  }

  currentTake() {
    return this.current ? cloneTake(this.current) : null;
  }

  statusPayload() {
    return {
      type: 'take-status',
      lifecycle: this.lifecycle,
      take: this.currentTake(),
    };
  }
}
