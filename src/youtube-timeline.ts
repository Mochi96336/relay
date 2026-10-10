import { performance } from 'node:perf_hooks';

const ENDED = 0;
const PLAYING = 1;
const STALE_AFTER_MS = 1_500;
const DISCONTINUITY_THRESHOLD_MS = 750;
const MIN_PLAYING_PROGRESS_SECONDS = 0.005;
const DRIFT_WINDOW_MS = 30_000;
const MIN_DRIFT_SPAN_MS = 8_000;
const PHASE_CORRECTION_THRESHOLD_MS = 450;
const PHASE_CORRECTION_CONFIRMATIONS = 3;

type TimelineAnchor = {
  videoId: string;
  positionSeconds: number;
  serverAtMs: number;
  state: number;
  playbackRate: number;
};

type LatestTelemetry = {
  videoId: string;
  videoTitle: string | null;
  videoAuthor: string | null;
  state: number;
  currentTime: number;
  duration: number;
  playbackRate: number;
  bufferedFraction: number;
  receivedAtServerMs: number;
  estimatedSampleAtServerMs: number;
  timelineDeltaSeconds: number;
  networkRttMs: number | null;
};

type RateSample = {
  atMs: number;
  mediaSeconds: number;
};

type DriftStats = {
  driftMsPerMinute: number;
  jitterMs: number;
};

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function metadataText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, maxLength).join('');
}

export class YouTubeTimelineTracker {
  private anchor: TimelineAnchor | null = null;
  private latest: LatestTelemetry | null = null;
  private rateHistory: RateSample[] = [];
  private reanchors = 0;
  private corrections = 0;
  private lastReason = 'waiting';
  private phaseDirection = 0;
  private phaseConfirmations = 0;
  private phaseCorrections = 0;
  private lastPhaseCorrectionMs: number | null = null;
  /**
   * Last evidence that a PLAYING media clock itself moved.
   *
   * Packet freshness and clock freshness are different facts. A wedged iframe
   * can keep emitting PLAYING telemetry every 250 ms while getCurrentTime()
   * remains frozen forever. That transport is alive, but it no longer owns a
   * trustworthy room clock.
   */
  private playingProgressAtMs = Number.NEGATIVE_INFINITY;
  private playingProgressPositionSeconds: number | null = null;

  get hasTelemetry() {
    return this.latest !== null;
  }

  update(payload: Record<string, unknown>, nowMs = performance.now()) {
    const videoId = typeof payload.videoId === 'string' ? payload.videoId : '';
    const currentTime = finiteNumber(payload.currentTime, Number.NaN);
    const state = Math.trunc(finiteNumber(payload.state, -1));

    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Number.isFinite(currentTime) || currentTime < 0) {
      return false;
    }

    const playbackRate = boundedNumber(payload.playbackRate, 0.25, 4, 1);
    const duration = Math.max(0, finiteNumber(payload.duration, 0));
    const bufferedFraction = boundedNumber(payload.bufferedFraction, 0, 1, 0);
    const timelineDeltaSeconds = finiteNumber(payload.timelineDeltaSeconds, 0);
    const networkRtt = finiteNumber(payload.networkRttMs ?? payload.clockRttMs, Number.NaN);
    const networkRttMs = Number.isFinite(networkRtt) ? Math.max(0, networkRtt) : null;
    const transportEstimateMs = networkRttMs === null ? 0 : networkRttMs / 2;
    const estimatedSampleAtServerMs = nowMs - transportEstimateMs;
    const previous = this.latest;

    this.latest = {
      videoId,
      videoTitle: metadataText(payload.videoTitle, 180) ?? previous?.videoTitle ?? null,
      videoAuthor: metadataText(payload.videoAuthor, 96) ?? previous?.videoAuthor ?? null,
      state,
      currentTime,
      duration,
      playbackRate,
      bufferedFraction,
      receivedAtServerMs: nowMs,
      estimatedSampleAtServerMs,
      timelineDeltaSeconds,
      networkRttMs,
    };

    // Metadata belongs to the current video only. A new media identity must not
    // inherit the old title/author while getVideoData() is still catching up.
    if (previous?.videoId !== videoId) {
      this.latest.videoTitle = metadataText(payload.videoTitle, 180);
      this.latest.videoAuthor = metadataText(payload.videoAuthor, 96);
    }

    const before = this.project(nowMs);
    const reportedNow = this.projectTelemetry(this.latest, nowMs);
    const sameVideo = before?.videoId === videoId;
    const phaseErrorMs = sameVideo && before ? (reportedNow - before.positionSeconds) * 1000 : null;

    const stateChanged = !this.anchor || this.anchor.state !== state;
    const rateChanged = !this.anchor || Math.abs(this.anchor.playbackRate - playbackRate) > 0.0001;
    const videoChanged = !this.anchor || this.anchor.videoId !== videoId;
    const explicitJump = Math.abs(timelineDeltaSeconds) > 0.4;

    // A seek commonly passes through buffering, so continuity must be checked
    // across state changes rather than only between two playing samples.
    let continuityErrorMs: number | null = null;
    if (
      previous &&
      previous.videoId === videoId &&
      Math.abs(previous.playbackRate - playbackRate) < 0.0001
    ) {
      const serverDeltaSeconds = Math.max(0, nowMs - previous.receivedAtServerMs) / 1000;
      const expectedMediaDelta = previous.state === PLAYING
        ? serverDeltaSeconds * previous.playbackRate
        : 0;
      const actualMediaDelta = currentTime - previous.currentTime;
      continuityErrorMs = (actualMediaDelta - expectedMediaDelta) * 1000;
    }

    const discontinuity = continuityErrorMs !== null && Math.abs(continuityErrorMs) > DISCONTINUITY_THRESHOLD_MS;
    const abruptCorrection = explicitJump || discontinuity;
    const mediaPositionChanged = previous === null
      || Math.abs(currentTime - previous.currentTime) >= MIN_PLAYING_PROGRESS_SECONDS;
    // Small per-packet rate errors can accumulate indefinitely without a seek.
    // Require fresh, advancing evidence on the same side of the room clock;
    // a frozen player or a single late/noisy report must not move its anchor.
    const phaseDirection = !videoChanged && !stateChanged && !rateChanged
      && !abruptCorrection && state === PLAYING && previous
      && nowMs > previous.receivedAtServerMs
      && nowMs - previous.receivedAtServerMs <= STALE_AFTER_MS
      && currentTime - previous.currentTime >= MIN_PLAYING_PROGRESS_SECONDS
      && phaseErrorMs !== null && Math.abs(phaseErrorMs) > PHASE_CORRECTION_THRESHOLD_MS
      ? Math.sign(phaseErrorMs) : 0;
    this.phaseConfirmations = phaseDirection === 0 ? 0
      : phaseDirection === this.phaseDirection ? this.phaseConfirmations + 1 : 1;
    this.phaseDirection = phaseDirection;
    const phaseCorrection = this.phaseConfirmations >= PHASE_CORRECTION_CONFIRMATIONS;
    const correction = abruptCorrection || phaseCorrection;
    this.trackClockProgress({
      state,
      currentTime,
      nowMs,
      // A long browser-timer gap can make a frozen PLAYING report look like a
      // discontinuity. Correction classification alone is therefore not proof
      // of clock progress: the media position itself must have changed.
      reset: videoChanged
        || stateChanged
        || rateChanged
        || (correction && mediaPositionChanged)
        || phaseErrorMs === null,
    });

    if (videoChanged || stateChanged || rateChanged || correction || phaseErrorMs === null) {
      if (this.anchor) {
        if (correction) this.corrections += 1;
        else this.reanchors += 1;
      }

      this.anchor = {
        videoId,
        positionSeconds: currentTime,
        serverAtMs: estimatedSampleAtServerMs,
        state,
        playbackRate,
      };
      this.phaseConfirmations = 0;
      this.phaseDirection = 0;
      if (phaseCorrection) {
        this.phaseCorrections += 1;
        this.lastPhaseCorrectionMs = phaseErrorMs;
      } else this.rateHistory = [];
      if (state === PLAYING) this.pushRateSample(nowMs, currentTime);
      this.lastReason = videoChanged
        ? 'video'
        : phaseCorrection
          ? 'phase-drift'
        : correction
          ? 'seek/jump'
          : stateChanged
            ? 'state'
            : rateChanged
              ? 'rate'
              : 'initial';
      return true;
    }

    if (state === PLAYING) this.pushRateSample(nowMs, currentTime);
    else this.rateHistory = [];

    this.lastReason = 'tracking';
    return true;
  }

  statusPayload(nowMs = performance.now()) {
    if (!this.latest || !this.anchor) {
      return {
        type: 'youtube-timeline-status',
        connected: false,
      };
    }

    const projected = this.project(nowMs);
    // A clock projected past the end of the media describes nothing: a 3:40
    // Song is never at 9:07:25. Clamp both readings to a known duration.
    const knownEndSeconds = this.latest.duration > 0 ? this.latest.duration : null;
    const atEnd = (seconds: number) => (
      knownEndSeconds === null ? seconds : Math.min(seconds, knownEndSeconds)
    );
    const unclampedServerTime = projected?.positionSeconds
      ?? this.projectTelemetry(this.latest, nowMs);
    const youtubeTime = atEnd(this.projectTelemetry(this.latest, nowMs));
    const serverTime = atEnd(unclampedServerTime);
    const differenceMs = (youtubeTime - serverTime) * 1000;
    const telemetryAgeMs = Math.max(0, nowMs - this.latest.receivedAtServerMs);
    const progressAgeMs = Number.isFinite(this.playingProgressAtMs)
      ? Math.max(0, nowMs - this.playingProgressAtMs)
      : telemetryAgeMs;
    const clockAgeMs = this.latest.state === PLAYING
      ? Math.max(telemetryAgeMs, progressAgeMs)
      : telemetryAgeMs;
    const transportEstimateMs = Math.max(0, this.latest.receivedAtServerMs - this.latest.estimatedSampleAtServerMs);
    const driftStats = this.estimateDriftStats();
    const connected = clockAgeMs <= STALE_AFTER_MS;
    // A live holder reports the end itself. Once its clock is stale, nothing
    // will: on 2026-10-04 the room kept "playing" a finished Song for nine
    // hours after the holder left. A PLAYING clock that has run to the end
    // with no holder has ended.
    const endedWithoutHolder = !connected
      && this.latest.state === PLAYING
      && knownEndSeconds !== null
      && unclampedServerTime >= knownEndSeconds;

    return {
      type: 'youtube-timeline-status',
      connected,
      measurementMode: 'media-vs-server-monotonic',
      videoId: this.latest.videoId,
      videoTitle: this.latest.videoTitle,
      videoAuthor: this.latest.videoAuthor,
      state: endedWithoutHolder ? ENDED : this.latest.state,
      duration: this.latest.duration,
      playbackRate: this.latest.playbackRate,
      bufferedFraction: this.latest.bufferedFraction,
      youtubeTime,
      serverTime,
      differenceMs,
      driftMsPerMinute: driftStats?.driftMsPerMinute ?? null,
      measurementJitterMs: driftStats?.jitterMs ?? null,
      networkRttMs: this.latest.networkRttMs,
      clockRttMs: this.latest.networkRttMs,
      transportEstimateMs,
      // Compatibility age is clock-authority age. Keep raw packet freshness
      // separately so diagnostics can distinguish a dead transport from a live
      // transport publishing a frozen PLAYING clock.
      ageMs: clockAgeMs,
      clockAgeMs,
      telemetryAgeMs,
      reanchors: this.reanchors,
      corrections: this.corrections,
      hardResyncs: this.corrections,
      phaseCorrections: this.phaseCorrections,
      lastPhaseCorrectionMs: this.lastPhaseCorrectionMs,
      lastReason: this.lastReason,
    };
  }

  private trackClockProgress(input: {
    state: number;
    currentTime: number;
    nowMs: number;
    reset: boolean;
  }) {
    if (input.state !== PLAYING) {
      this.playingProgressAtMs = input.nowMs;
      this.playingProgressPositionSeconds = input.currentTime;
      return;
    }

    if (
      input.reset
      || this.playingProgressPositionSeconds === null
      || !Number.isFinite(this.playingProgressAtMs)
      || input.currentTime - this.playingProgressPositionSeconds >= MIN_PLAYING_PROGRESS_SECONDS
    ) {
      this.playingProgressAtMs = input.nowMs;
      this.playingProgressPositionSeconds = input.currentTime;
    }
  }

  private project(atMs: number) {
    if (!this.anchor) return null;
    const elapsedSeconds = Math.max(0, atMs - this.anchor.serverAtMs) / 1000;
    const positionSeconds = this.anchor.state === PLAYING
      ? this.anchor.positionSeconds + elapsedSeconds * this.anchor.playbackRate
      : this.anchor.positionSeconds;

    return {
      videoId: this.anchor.videoId,
      positionSeconds,
    };
  }

  private projectTelemetry(telemetry: LatestTelemetry, atMs: number) {
    const elapsedSeconds = Math.max(0, atMs - telemetry.estimatedSampleAtServerMs) / 1000;
    return telemetry.state === PLAYING
      ? telemetry.currentTime + elapsedSeconds * telemetry.playbackRate
      : telemetry.currentTime;
  }

  private pushRateSample(atMs: number, mediaSeconds: number) {
    this.rateHistory.push({ atMs, mediaSeconds });
    const cutoff = atMs - DRIFT_WINDOW_MS;
    while (this.rateHistory.length > 0 && this.rateHistory[0].atMs < cutoff) {
      this.rateHistory.shift();
    }
  }

  private estimateDriftStats(): DriftStats | null {
    if (!this.latest || this.latest.state !== PLAYING || this.rateHistory.length < 8) return null;

    const first = this.rateHistory[0];
    const last = this.rateHistory[this.rateHistory.length - 1];
    if (last.atMs - first.atMs < MIN_DRIFT_SPAN_MS) return null;

    const originAtMs = first.atMs;
    const originMedia = first.mediaSeconds;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;

    for (const sample of this.rateHistory) {
      const x = (sample.atMs - originAtMs) / 1000;
      const y = sample.mediaSeconds - originMedia;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }

    const count = this.rateHistory.length;
    const denominator = count * sumXX - sumX * sumX;
    if (Math.abs(denominator) < 1e-9) return null;

    const slope = (count * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / count;
    let residualSquares = 0;

    for (const sample of this.rateHistory) {
      const x = (sample.atMs - originAtMs) / 1000;
      const y = sample.mediaSeconds - originMedia;
      const residualSeconds = y - (intercept + slope * x);
      residualSquares += residualSeconds * residualSeconds;
    }

    const jitterMs = Math.sqrt(residualSquares / count) * 1000;
    const driftMsPerMinute = (slope - this.latest.playbackRate) * 60_000;

    return {
      driftMsPerMinute,
      jitterMs,
    };
  }
}
