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
/**
 * Anchor refinement. The anchor is one report: its position, placed on the
 * server clock by assuming it travelled for half the page's best round trip.
 * A report can be delayed past that and never arrive before it was sent, so
 * an anchor taken from a delayed report sits behind the player by that delay,
 * for the whole song: nothing under the 450 ms phase threshold moved it. Over
 * a jittery control path a simulated 14-31% of song starts were more than
 * 50 ms behind, and a boot calibration is wrong by the same amount, because
 * the Robot follows this clock and its offset is measured against it.
 *
 * Later reports are delayed too, each by its own amount, so the least delayed
 * of them shows where the player is. When even the least delayed recent
 * reports put the player ahead of the clock, the clock moves up to them.
 *
 * Forward only. Reports that are all late may be a congested uplink, which
 * says nothing about the player. And a report counts as ahead only as far as
 * it is ahead under the transport estimate the anchor was taken with: a round
 * trip that grew since (a congested downlink) makes every report look
 * fresher without the player having moved.
 *
 * Only while the anchor is new. A delayed anchor shows from the first reports
 * after it. Reports that turn up ahead later are a path that got faster
 * before the page measured its new round trip, and moving for those left the
 * clock ahead once it did (44 ms in simulation, for a 60 ms faster uplink).
 */
/**
 * Report de-jittering. Each report says when the page sampled the player, on
 * the page's own clock. Arrival minus that is the clock offset plus the
 * report's travel time, and the smallest recent value is the offset plus the
 * path's best: how much a report exceeds it is how much longer it travelled,
 * whatever the two clocks read. Without it every report was assumed to have
 * travelled for half the best round trip, so a report held up for 200 ms
 * put the player 200 ms behind: the Robot follows the newest report, its
 * offset is measured against it, and a boot calibration moved with every
 * stretch of late reports ("delta moved").
 */
const CLOCK_OFFSET_WINDOW_MS = 60_000;
/** Longer than this is a stalled page or a stepped clock, not travel time: start over. */
const CLOCK_EXCESS_LIMIT_MS = 1_000;
const REFINE_THRESHOLD_MS = 30;
/** Reports (2 s) whose second-furthest ahead decides a move. */
const REFINE_REPORTS = 8;
/** How long after anchoring the reports may still move the anchor. */
const REFINE_SETTLE_MS = 6_000;

type TimelineAnchor = {
  videoId: string;
  positionSeconds: number;
  serverAtMs: number;
  state: number;
  playbackRate: number;
  /** How long the anchoring report was assumed to have travelled. */
  transportEstimateMs: number;
  /** When the anchoring report arrived. */
  anchoredAtMs: number;
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

export type YouTubeTimelineOptions = {
  /**
   * Measure each report's travel time from the page's sample clock and settle
   * new anchors. Off treats every report as having travelled half the page's
   * best round trip, as before 2026-11-12.
   */
  reportTravelTime?: boolean;
};

export class YouTubeTimelineTracker {
  private readonly reportTravelTime: boolean;

  constructor(options: YouTubeTimelineOptions = {}) {
    this.reportTravelTime = options.reportTravelTime ?? true;
  }

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
  /** Whose clock `clockOffsets` are on: one page load of one playback tab. */
  private clockKey: string | null = null;
  /** For recent reports: arrival minus the page's sample time, and half the round trip the page reported. */
  private clockOffsets: { atMs: number; offsetMs: number; halfRttMs: number }[] = [];
  /** Phase errors of the reports since the anchor last moved, newest last. */
  private refineWindow: number[] = [];
  private refinements = 0;
  private lastRefinementMs: number | null = null;
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
    const previous = this.latest;
    const transportEstimateMs = this.reportTransportMs(payload, networkRttMs, nowMs, previous);
    const estimatedSampleAtServerMs = nowMs - transportEstimateMs;

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
    const comparablePhaseErrorMs = !videoChanged && !stateChanged && !rateChanged
      && !abruptCorrection && state === PLAYING && previous
      && nowMs > previous.receivedAtServerMs
      && nowMs - previous.receivedAtServerMs <= STALE_AFTER_MS
      && currentTime - previous.currentTime >= MIN_PLAYING_PROGRESS_SECONDS
      ? phaseErrorMs : null;
    const phaseDirection = comparablePhaseErrorMs !== null
      && Math.abs(comparablePhaseErrorMs) > PHASE_CORRECTION_THRESHOLD_MS
      ? Math.sign(comparablePhaseErrorMs) : 0;
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
        transportEstimateMs,
        anchoredAtMs: nowMs,
      };
      this.phaseConfirmations = 0;
      this.phaseDirection = 0;
      this.refineWindow = [];
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

    this.lastReason = this.refineAnchor(comparablePhaseErrorMs, transportEstimateMs, nowMs) ? 'refined' : 'tracking';
    return true;
  }

  /**
   * How long this report travelled, by the page's sample clock.
   *
   * Arrival minus sample time is the offset between the two clocks plus the
   * travel time. The smallest recent value belongs to the path's best, and a
   * report's excess over it is how much longer it took. The path's best is
   * half the smallest round trip the page reported in the same window, so a
   * round trip that rises for a while (a congested downlink) moves nothing.
   * An uplink that gets faster is seen here at once and by the page a few
   * seconds later: until then reports look that much older than they are, as
   * they did before this estimate existed. A report without a sample time is
   * assumed, as before, to have travelled half its round trip.
   */
  private reportTransportMs(
    payload: Record<string, unknown>, networkRttMs: number | null, nowMs: number, previous: LatestTelemetry | null,
  ) {
    const halfRttMs = networkRttMs === null ? 0 : networkRttMs / 2;
    const sampledAtMs = Number(payload.sampledAtPerformanceMs);
    if (!this.reportTravelTime || payload.sampledAtPerformanceMs === undefined || payload.sampledAtPerformanceMs === null
      || !Number.isFinite(sampledAtMs) || sampledAtMs < 0) {
      this.clockKey = null;
      this.clockOffsets = [];
      return halfRttMs;
    }
    const key = `${String(payload.playbackTransportId ?? '')}|${String(payload.playbackGeneration ?? '')}`;
    const offsetMs = nowMs - sampledAtMs;
    // Another page or reload is another clock; after a silence the page may
    // have slept, and its clock with it.
    if (key !== this.clockKey || !previous || nowMs - previous.receivedAtServerMs > STALE_AFTER_MS) {
      this.clockKey = key;
      this.clockOffsets = [];
    }
    while (this.clockOffsets.length > 0 && this.clockOffsets[0].atMs < nowMs - CLOCK_OFFSET_WINDOW_MS) {
      this.clockOffsets.shift();
    }
    let bestOffsetMs = offsetMs;
    let bestHalfRttMs = halfRttMs;
    for (const earlier of this.clockOffsets) {
      bestOffsetMs = Math.min(bestOffsetMs, earlier.offsetMs);
      bestHalfRttMs = Math.min(bestHalfRttMs, earlier.halfRttMs);
    }
    if (offsetMs - bestOffsetMs > CLOCK_EXCESS_LIMIT_MS) {
      this.clockOffsets = [{ atMs: nowMs, offsetMs, halfRttMs }];
      return halfRttMs;
    }
    this.clockOffsets.push({ atMs: nowMs, offsetMs, halfRttMs });
    return bestHalfRttMs + offsetMs - bestOffsetMs;
  }

  /**
   * The server's clock minus the reporting page's, and whose page it is; null
   * until two seconds of its reports have been measured, or once they stop.
   */
  pageClock(nowMs = performance.now()) {
    const newest = this.clockOffsets.at(-1);
    if (!this.reportTravelTime || this.clockKey === null || !newest
      || this.clockOffsets.length < REFINE_REPORTS || nowMs - newest.atMs > STALE_AFTER_MS) return null;
    let bestOffsetMs = Infinity;
    let bestHalfRttMs = Infinity;
    for (const sample of this.clockOffsets) {
      bestOffsetMs = Math.min(bestOffsetMs, sample.offsetMs);
      bestHalfRttMs = Math.min(bestHalfRttMs, sample.halfRttMs);
    }
    return { key: this.clockKey, offsetMs: bestOffsetMs - bestHalfRttMs };
  }

  /**
   * Moves the anchor to where the least delayed recent reports put the
   * player. Not a correction: the song did not jump, the room's estimate of
   * it improved, so the room song revision stays.
   */
  private refineAnchor(phaseErrorMs: number | null, transportEstimateMs: number, nowMs: number) {
    if (!this.reportTravelTime || !this.anchor || phaseErrorMs === null
      || nowMs - this.anchor.anchoredAtMs > REFINE_SETTLE_MS) {
      this.refineWindow = [];
      return false;
    }
    const estimateGrowthMs = Math.max(0, transportEstimateMs - this.anchor.transportEstimateMs);
    this.refineWindow.push(phaseErrorMs - estimateGrowthMs * this.anchor.playbackRate);
    if (this.refineWindow.length > REFINE_REPORTS) this.refineWindow.shift();
    if (this.refineWindow.length < REFINE_REPORTS) return false;
    // The second furthest ahead: one odd reading cannot move the clock.
    const aheadMs = [...this.refineWindow].sort((a, b) => b - a)[1];
    if (aheadMs <= REFINE_THRESHOLD_MS) return false;
    this.anchor.positionSeconds += aheadMs / 1000;
    this.refinements += 1;
    this.lastRefinementMs = aheadMs;
    this.refineWindow = [];
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
      refinements: this.refinements,
      lastRefinementMs: this.lastRefinementMs,
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
