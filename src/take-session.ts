export type TakeLifecycle = 'idle' | 'recording' | 'finalizing' | 'ready' | 'failed';

export type TakeStopReason = 'user' | 'mix-ended';

export type TakeSongSnapshot = {
  videoId: string;
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

function cloneTake(take: TakeRecord): TakeRecord {
  return {
    ...take,
    song: cloneSong(take.song),
    artifact: cloneArtifact(take.artifact),
  };
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
      error: null,
    };
    return { ok: true, take: cloneTake(this.current) };
  }

  beginFinalizing(input: {
    takeId: string;
    stoppedByParticipantId: string | null;
    stopReason: TakeStopReason;
    endedAtMs: number;
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

  fail(takeId: string, error: string, endedAtMs: number) {
    if (!this.current || this.current.takeId !== takeId) return false;
    if (this.current.lifecycle === 'ready' || this.current.lifecycle === 'failed') return false;

    this.current.lifecycle = 'failed';
    this.current.endedAtMs ??= endedAtMs;
    this.current.error = error;
    this.current.artifact = null;
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
