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
 * missing packet. A health report that is itself delayed lowers it, so it can
 * read below zero.
 *
 * Diagnostic evidence only: it decides nothing.
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
};

export const DEFAULT_MIC_UPLINK_BACKLOG_START_MS = 400;
export const DEFAULT_MIC_UPLINK_BACKLOG_END_MS = 200;
export const DEFAULT_MIC_UPLINK_BACKLOG_REPEAT_MS = 2_000;

type Episode = { startedAtMs: number; reportedAtMs: number; maxBacklogMs: number };

export class MicUplinkBacklog {
  private readonly startMs: number;
  private readonly endMs: number;
  private readonly repeatMs: number;
  private arrivedGeneration: number | null = null;
  private newestArrivedEndSample: number | null = null;
  private latest: MicUplinkBacklogStatus | null = null;
  private episode: Episode | null = null;

  constructor({
    startMs = DEFAULT_MIC_UPLINK_BACKLOG_START_MS,
    endMs = DEFAULT_MIC_UPLINK_BACKLOG_END_MS,
    repeatMs = DEFAULT_MIC_UPLINK_BACKLOG_REPEAT_MS,
  }: MicUplinkBacklogOptions = {}) {
    if (!(endMs < startMs)) throw new RangeError('endMs must be below startMs');
    if (!(repeatMs > 0)) throw new RangeError('repeatMs must be positive');
    this.startMs = startMs;
    this.endMs = endMs;
    this.repeatMs = repeatMs;
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
    if (
      generation !== this.arrivedGeneration
      || this.newestArrivedEndSample === null
      || !Number.isFinite(capturedSamples)
      || !(sampleRate > 0)
    ) return null;

    const backlogMs = Math.round(((capturedSamples - this.newestArrivedEndSample) / sampleRate) * 1000);
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
