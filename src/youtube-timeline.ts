import { performance } from 'node:perf_hooks';

const PLAYING = 1;
const STALE_AFTER_MS = 1_500;
const DISCONTINUITY_THRESHOLD_MS = 750;
const DRIFT_WINDOW_MS = 30_000;
const MIN_DRIFT_SPAN_MS = 8_000;

type TimelineAnchor = {
  videoId: string;
  positionSeconds: number;
  serverAtMs: number;
  state: number;
  playbackRate: number;
};

type LatestTelemetry = {
  videoId: string;
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

export class YouTubeTimelineTracker {
  private anchor: TimelineAnchor | null = null;
  private latest: LatestTelemetry | null = null;
  private rateHistory: RateSample[] = [];
  private reanchors = 0;
  private corrections = 0;
  private lastReason = 'waiting';

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

    const before = this.project(nowMs);
    const reportedNow = this.projectTelemetry(this.latest, nowMs);
    const sameVideo = before?.videoId === videoId;
    const phaseErrorMs = sameVideo && before ? (reportedNow - before.positionSeconds) * 1000 : null;

    const stateChanged = !this.anchor || this.anchor.state !== state;
    const rateChanged = !this.anchor || Math.abs(this.anchor.playbackRate - playbackRate) > 0.0001;
    const videoChanged = !this.anchor || this.anchor.videoId !== videoId;
    const explicitJump = Math.abs(timelineDeltaSeconds) > 0.4;

    let continuityErrorMs: number | null = null;
    if (
      previous &&
      previous.videoId === videoId &&
      previous.state === PLAYING &&
      state === PLAYING &&
      Math.abs(previous.playbackRate - playbackRate) < 0.0001
    ) {
      const serverDeltaSeconds = Math.max(0, nowMs - previous.receivedAtServerMs) / 1000;
      const expectedMediaDelta = serverDeltaSeconds * playbackRate;
      const actualMediaDelta = currentTime - previous.currentTime;
      continuityErrorMs = (actualMediaDelta - expectedMediaDelta) * 1000;
    }

    const discontinuity = continuityErrorMs !== null && Math.abs(continuityErrorMs) > DISCONTINUITY_THRESHOLD_MS;
    const correction = explicitJump || discontinuity;

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
      this.rateHistory = [];
      if (state === PLAYING) this.pushRateSample(nowMs, currentTime);
      this.lastReason = videoChanged
        ? 'video'
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
    const youtubeTime = this.projectTelemetry(this.latest, nowMs);
    const serverTime = projected?.positionSeconds ?? youtubeTime;
    const differenceMs = (youtubeTime - serverTime) * 1000;
    const ageMs = Math.max(0, nowMs - this.latest.receivedAtServerMs);
    const transportEstimateMs = Math.max(0, this.latest.receivedAtServerMs - this.latest.estimatedSampleAtServerMs);
    const driftStats = this.estimateDriftStats();

    return {
      type: 'youtube-timeline-status',
      connected: ageMs <= STALE_AFTER_MS,
      measurementMode: 'media-vs-server-monotonic',
      videoId: this.latest.videoId,
      state: this.latest.state,
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
      ageMs,
      reanchors: this.reanchors,
      corrections: this.corrections,
      hardResyncs: this.corrections,
      lastReason: this.lastReason,
    };
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
