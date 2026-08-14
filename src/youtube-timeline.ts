const PLAYING = 1;
const STALE_AFTER_MS = 1_500;
const HARD_RESYNC_THRESHOLD_MS = 500;
const HISTORY_WINDOW_MS = 12_000;

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
  sampledAtServerMs: number;
  receivedAtServerMs: number;
  timelineDeltaSeconds: number;
  clockRttMs: number | null;
};

type ErrorSample = {
  atMs: number;
  errorMs: number;
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
  private errorHistory: ErrorSample[] = [];
  private reanchors = 0;
  private corrections = 0;
  private lastReason = 'waiting';

  get hasTelemetry() {
    return this.latest !== null;
  }

  update(payload: Record<string, unknown>, nowMs = Date.now()) {
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
    const clockRtt = finiteNumber(payload.clockRttMs, Number.NaN);

    let sampledAtServerMs = finiteNumber(payload.sampledAtServerMs, nowMs);
    if (Math.abs(sampledAtServerMs - nowMs) > 30_000) sampledAtServerMs = nowMs;

    this.latest = {
      videoId,
      state,
      currentTime,
      duration,
      playbackRate,
      bufferedFraction,
      sampledAtServerMs,
      receivedAtServerMs: nowMs,
      timelineDeltaSeconds,
      clockRttMs: Number.isFinite(clockRtt) ? Math.max(0, clockRtt) : null,
    };

    const before = this.project(nowMs);
    const reportedNow = this.projectTelemetry(this.latest, nowMs);
    const sameVideo = before?.videoId === videoId;
    const errorMs = sameVideo && before ? (reportedNow - before.positionSeconds) * 1000 : null;

    const stateChanged = !this.anchor || this.anchor.state !== state;
    const rateChanged = !this.anchor || Math.abs(this.anchor.playbackRate - playbackRate) > 0.0001;
    const videoChanged = !this.anchor || this.anchor.videoId !== videoId;
    const explicitJump = Math.abs(timelineDeltaSeconds) > 0.4;
    const largeError = errorMs !== null && Math.abs(errorMs) > HARD_RESYNC_THRESHOLD_MS;
    const correction = explicitJump || largeError;

    if (videoChanged || stateChanged || rateChanged || correction || errorMs === null) {
      if (this.anchor) {
        if (correction) this.corrections += 1;
        else this.reanchors += 1;
      }

      this.anchor = {
        videoId,
        positionSeconds: currentTime,
        serverAtMs: sampledAtServerMs,
        state,
        playbackRate,
      };
      this.errorHistory = [];
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

    this.errorHistory.push({ atMs: nowMs, errorMs });
    const cutoff = nowMs - HISTORY_WINDOW_MS;
    while (this.errorHistory.length > 0 && this.errorHistory[0].atMs < cutoff) {
      this.errorHistory.shift();
    }
    this.lastReason = 'tracking';
    return true;
  }

  statusPayload(nowMs = Date.now()) {
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

    return {
      type: 'youtube-timeline-status',
      connected: ageMs <= STALE_AFTER_MS,
      videoId: this.latest.videoId,
      state: this.latest.state,
      duration: this.latest.duration,
      playbackRate: this.latest.playbackRate,
      bufferedFraction: this.latest.bufferedFraction,
      youtubeTime,
      serverTime,
      differenceMs,
      driftMsPerMinute: this.estimateDriftMsPerMinute(),
      clockRttMs: this.latest.clockRttMs,
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
    const elapsedSeconds = Math.max(0, atMs - telemetry.sampledAtServerMs) / 1000;
    return telemetry.state === PLAYING
      ? telemetry.currentTime + elapsedSeconds * telemetry.playbackRate
      : telemetry.currentTime;
  }

  private estimateDriftMsPerMinute() {
    if (this.errorHistory.length < 4) return null;
    const first = this.errorHistory[0];
    const last = this.errorHistory[this.errorHistory.length - 1];
    if (last.atMs - first.atMs < 2_000) return null;

    const origin = first.atMs;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;

    for (const sample of this.errorHistory) {
      const x = sample.atMs - origin;
      const y = sample.errorMs;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }

    const count = this.errorHistory.length;
    const denominator = count * sumXX - sumX * sumX;
    if (Math.abs(denominator) < 1e-9) return null;

    const slopeMsPerMs = (count * sumXY - sumX * sumY) / denominator;
    return slopeMsPerMs * 60_000;
  }
}
