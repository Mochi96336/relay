/**
 * How far the newest Mic audio Relay has received trails what the phone has
 * captured, both counted in the phone's own sample numbering.
 *
 * Uplink health carries the capture's `capturedSamples` on the control path,
 * and every media packet carries `firstSampleIndex` in the same numbering (see
 * MicCaptureDeliveryMonitor). Their difference is captured audio that has not
 * reached Relay yet. Packets that are lost do not raise it, because the packets
 * after them still arrive. Audio waiting anywhere between the phone's capture
 * and the mixer does raise it, including the receiver's bounded wait for a
 * missing packet.
 *
 * The phone's capture position is not read from the latest report alone. The
 * reports cross the same network as the audio: on 2026-10-09 they lagged 2.6 to
 * 4.8 s on a bad Wi-Fi, and on the WebSocket path they queue behind the audio
 * itself, so the latest report said little was in transit while seconds were.
 * A report can only arrive late, never early, so the least-delayed of the
 * recent reports, carried forward to now, is where the capture is. That keeps
 * growing while no report arrives at all. Once every recent report lags, that
 * least-delayed one lags too; but a capture loses time slowly, 2-4% of real
 * time on 2026-10-03, while a lagging path adds seconds at once. So the
 * capture's position may fall behind real time by at most 5% of the time
 * between reports, and lag beyond that is taken for lag. A capture that loses
 * time reads high by what it lost since the least-delayed report.
 *
 * Diagnostic evidence, and what tells the mixer audio is in transit
 * (AudioSession.noteMicTransitBacklog). It decides nothing itself.
 */

export type MicUplinkBacklogStatus = {
  generation: number;
  /** Captured audio not yet received, as of the latest health report. */
  backlogMs: number;
  /** The largest backlog this capture has shown. */
  maxBacklogMs: number;
};

export type MicUplinkBacklogEdge = {
  edge: 'start' | 'continue' | 'end';
  generation: number;
  backlogMs: number;
  /** The largest backlog since this episode started. */
  episodeMaxBacklogMs: number;
  durationMs: number;
};

export type MicUplinkBacklogOptions = {
  /** An episode starts once the backlog reaches this. */
  startMs?: number;
  /** An episode ends once the backlog falls below this. */
  endMs?: number;
  /** While an episode lasts, it is logged again at most this often. */
  repeatMs?: number;
  /** Reports skipped at capture start, as MicCaptureDeliveryMonitor skips them. */
  warmupReports?: number;
  /** Recent reports whose least-delayed one gives the capture's position. */
  envelopeReports?: number;
};

export const DEFAULT_MIC_UPLINK_BACKLOG_START_MS = 400;
export const DEFAULT_MIC_UPLINK_BACKLOG_END_MS = 200;
export const DEFAULT_MIC_UPLINK_BACKLOG_REPEAT_MS = 2_000;
/** The most real time a capture is taken to lose, as a fraction. */
const MAX_CAPTURE_LOSS_FRACTION = 0.05;

type Episode = { startedAtMs: number; reportedAtMs: number; maxBacklogMs: number };

export class MicUplinkBacklog {
  private readonly startMs: number;
  private readonly endMs: number;
  private readonly repeatMs: number;
  private readonly warmupReports: number;
  private readonly envelopeReports: number;
  private arrivedGeneration: number | null = null;
  private newestArrivedEndSample: number | null = null;
  private healthGeneration: number | null = null;
  private sampleRate: number | null = null;
  private reportsSeen = 0;
  /** Arrival time minus captured time of recent reports, oldest first. */
  private readonly recentOffsetsMs: number[] = [];
  /** Arrival time minus captured time of where the capture is taken to be. */
  private envelopeOffsetMs: number | null = null;
  private envelopeAtMs: number | null = null;
  private latest: MicUplinkBacklogStatus | null = null;
  private episode: Episode | null = null;

  constructor({
    startMs = DEFAULT_MIC_UPLINK_BACKLOG_START_MS,
    endMs = DEFAULT_MIC_UPLINK_BACKLOG_END_MS,
    repeatMs = DEFAULT_MIC_UPLINK_BACKLOG_REPEAT_MS,
    warmupReports = 1,
    envelopeReports = 5,
  }: MicUplinkBacklogOptions = {}) {
    if (!(endMs < startMs)) throw new RangeError('endMs must be below startMs');
    if (!(repeatMs > 0)) throw new RangeError('repeatMs must be positive');
    if (!Number.isInteger(warmupReports) || warmupReports < 0) {
      throw new RangeError('warmupReports must be a non-negative integer');
    }
    if (!Number.isInteger(envelopeReports) || envelopeReports < 1) {
      throw new RangeError('envelopeReports must be a positive integer');
    }
    this.startMs = startMs;
    this.endMs = endMs;
    this.repeatMs = repeatMs;
    this.warmupReports = warmupReports;
    this.envelopeReports = envelopeReports;
  }

  /** A Mic packet reached the mixer: its capture and the sample after its last. */
  noteArrived(generation: number, endSample: number) {
    if (!Number.isFinite(endSample)) return;
    if (generation !== this.arrivedGeneration) {
      this.arrivedGeneration = generation;
      this.newestArrivedEndSample = endSample;
      return;
    }
    this.newestArrivedEndSample = Math.max(this.newestArrivedEndSample ?? endSample, endSample);
  }

  /**
   * Captured audio of the current capture not yet received at `nowMs`, or null
   * while there is no report past warm-up or no packet of that capture.
   */
  estimate(nowMs: number): { generation: number; backlogMs: number } | null {
    const generation = this.healthGeneration;
    const sampleRate = this.sampleRate;
    if (
      generation === null
      || sampleRate === null
      || generation !== this.arrivedGeneration
      || this.newestArrivedEndSample === null
      || this.envelopeOffsetMs === null
      || !Number.isFinite(nowMs)
    ) return null;
    const capturedMs = nowMs - this.envelopeOffsetMs;
    const arrivedMs = (this.newestArrivedEndSample / sampleRate) * 1000;
    return { generation, backlogMs: Math.round(capturedMs - arrivedMs) };
  }

  /**
   * An accepted uplink health report. Returns the edge to log, or null. A
   * report from a capture with no arrived packet yet says nothing.
   */
  observeHealth(report: {
    generation: number;
    capturedSamples: number;
    sampleRate: number;
    atMs: number;
  }): MicUplinkBacklogEdge | null {
    const { generation, capturedSamples, sampleRate, atMs } = report;
    if (!Number.isFinite(capturedSamples) || !(sampleRate > 0) || !Number.isFinite(atMs)) return null;
    if (generation !== this.healthGeneration || sampleRate !== this.sampleRate) {
      this.healthGeneration = generation;
      this.sampleRate = sampleRate;
      this.reportsSeen = 0;
      this.recentOffsetsMs.length = 0;
      this.envelopeOffsetMs = null;
      this.envelopeAtMs = null;
    }
    this.reportsSeen += 1;
    if (this.reportsSeen > this.warmupReports) {
      this.recentOffsetsMs.push(atMs - (capturedSamples / sampleRate) * 1000);
      if (this.recentOffsetsMs.length > this.envelopeReports) this.recentOffsetsMs.shift();
      const leastDelayed = Math.min(...this.recentOffsetsMs);
      this.envelopeOffsetMs = this.envelopeOffsetMs === null || this.envelopeAtMs === null
        ? leastDelayed
        : Math.min(
          leastDelayed,
          this.envelopeOffsetMs + MAX_CAPTURE_LOSS_FRACTION * Math.max(0, atMs - this.envelopeAtMs),
        );
      this.envelopeAtMs = atMs;
    }

    const estimate = this.estimate(atMs);
    if (!estimate) return null;
    const { backlogMs } = estimate;
    const previous = this.latest?.generation === generation ? this.latest : null;
    // A new capture's first report is not the end of the old capture's episode:
    // the old one is simply over, and is not logged again.
    if (!previous) this.episode = null;
    this.latest = {
      generation,
      backlogMs,
      maxBacklogMs: Math.max(previous?.maxBacklogMs ?? backlogMs, backlogMs),
    };

    const episode = this.episode;
    if (!episode) {
      if (backlogMs < this.startMs) return null;
      this.episode = { startedAtMs: atMs, reportedAtMs: atMs, maxBacklogMs: backlogMs };
      return { edge: 'start', generation, backlogMs, episodeMaxBacklogMs: backlogMs, durationMs: 0 };
    }

    episode.maxBacklogMs = Math.max(episode.maxBacklogMs, backlogMs);
    const edge = (
      kind: MicUplinkBacklogEdge['edge'],
    ): MicUplinkBacklogEdge => ({
      edge: kind,
      generation,
      backlogMs,
      episodeMaxBacklogMs: episode.maxBacklogMs,
      durationMs: Math.round(atMs - episode.startedAtMs),
    });
    if (backlogMs < this.endMs) {
      this.episode = null;
      return edge('end');
    }
    if (atMs - episode.reportedAtMs < this.repeatMs) return null;
    episode.reportedAtMs = atMs;
    return edge('continue');
  }

  status(): MicUplinkBacklogStatus | null {
    return this.latest ? { ...this.latest } : null;
  }
}
