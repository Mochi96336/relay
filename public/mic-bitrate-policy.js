/** Trial policy: local congestion and fresh media delivery, never RTT alone. */
export class MicBitratePolicy {
  /** The lowest step congestion may reach. A premixed song needs 64 kbps; 32 is for voice. */
  floor = 32000;
  constructor() { this.reset(); }
  reset() {
    this.bitrate = 128000; this.reason = 'startup'; this.changedAt = null;
    this.badSince = null; this.goodSince = null; this.previous = null;
  }
  observe({ nowMs, generation, path, eligible, congestedRejects, audioBacklogMs, queueAgeMs, mixPlayable }) {
    if (!Number.isFinite(nowMs)) return this.status();
    const previous = this.previous;
    this.previous = { nowMs, generation, path, eligible, congestedRejects };
    const continuous = previous && previous.eligible && previous.generation === generation && previous.path === path
      && nowMs > previous.nowMs && nowMs - previous.nowMs <= 1500;
    if (!eligible || !continuous) {
      this.badSince = this.goodSince = null;
      return this.status();
    }
    const freshBacklog = typeof audioBacklogMs === 'number' && Number.isFinite(audioBacklogMs) && audioBacklogMs >= 0;
    const congestion = Number.isSafeInteger(congestedRejects) && Number.isSafeInteger(previous.congestedRejects)
      && congestedRejects > previous.congestedRejects;
    const bad = congestion || (freshBacklog && audioBacklogMs > 300)
      || (typeof queueAgeMs === 'number' && queueAgeMs > 200);
    const good = freshBacklog && audioBacklogMs < 100 && mixPlayable === true && !congestion
      && typeof queueAgeMs === 'number' && queueAgeMs < 50;
    if (bad) { this.badSince ??= previous.nowMs; this.goodSince = null; }
    else if (good) { this.goodSince ??= previous.nowMs; this.badSince = null; }
    else { this.badSince = this.goodSince = null; }
    const cooldown = this.changedAt === null || nowMs - this.changedAt >= 5000;
    if (bad && this.badSince !== null && nowMs - this.badSince >= 3000 && cooldown && this.bitrate > this.floor) {
      this.bitrate = this.bitrate === 128000 ? 64000 : 32000;
      this.reason = congestion ? 'congestion' : 'media-backlog';
      this.changedAt = nowMs; this.badSince = null;
    } else if (good && this.goodSince !== null && nowMs - this.goodSince >= 30000 && cooldown && this.bitrate < 128000) {
      this.bitrate = this.bitrate === 32000 ? 64000 : 128000;
      this.reason = 'stable-delivery'; this.changedAt = nowMs; this.goodSince = null;
    }
    return this.status();
  }
  status() { return { bitrate: this.bitrate, reason: this.reason }; }
}
