/**
 * How far ahead of the room B's local song plays.
 *
 * The room cannot wait for B: the mixer reads at most prebuffer − safety
 * (200 ms live) ahead in B's audio, and any more of B's lag is heard late.
 * On 2026-10-31 B's YouTube-time lag was 1505 ms, so B was heard about 1.3 s
 * late. B hears the song earlier instead: once B's lag leaves the band, the
 * lead moves by what brings the lag to the target. The target is below zero
 * because YouTube time does not see B's device (Bluetooth output and input),
 * which adds to the lag the mixer must absorb; a lag below zero only reads
 * B's history.
 *
 * The lag is read only from anchors taken after B's follower applied the
 * current lead (B reports the lead its player was last moved to), so a
 * measurement from before the move never counts twice.
 */
export class ChoirLead {
  private lead = 0;
  /** The lead B's page last said its player runs at. */
  private reported = 0;
  /** Anchors in a row that report the current lead. */
  private confirmed = 0;

  constructor(private readonly options: {
    /** Where a move puts B's YouTube-time lag. */
    targetMs: number;
    /** Lags past this move B: below the 200 ms the mixer can absorb. */
    lateMs: number;
    /** Lags under this waste the mixer's history; B is far ahead. */
    earlyMs: number;
    maxLeadMs: number;
    /** Anchors at the current lead before its lag is trusted. */
    settleAnchors: number;
  } = { targetMs: -100, lateMs: 100, earlyMs: -600, maxLeadMs: 3_000, settleAnchors: 4 }) {}

  get leadMs() { return this.lead; }
  /** What B's player runs at now, as B reported it; B's probe lag counts it. */
  get appliedMs() { return this.reported; }

  /** A song-time anchor from B's page, with the lead its player was last moved to. */
  anchor(reportedMs: number) {
    this.reported = reportedMs;
    this.confirmed = reportedMs === this.lead ? this.confirmed + 1 : 0;
  }

  /** B reports a lead the server did not ask for (a reload): send the current one. */
  get mismatched() { return this.reported !== this.lead; }

  /** B's YouTube-time lag now. Returns the new lead when it changes. */
  update(lagMs: number | null): number | null {
    const { targetMs, lateMs, earlyMs, maxLeadMs, settleAnchors } = this.options;
    if (lagMs === null || !Number.isFinite(lagMs) || this.confirmed < settleAnchors) return null;
    if (lagMs <= lateMs && lagMs >= earlyMs) return null;
    const next = Math.max(0, Math.min(maxLeadMs, Math.round((this.lead + lagMs - targetMs) / 10) * 10));
    if (next === this.lead) return null;
    this.lead = next;
    this.confirmed = 0;
    return next;
  }

  reset() {
    this.lead = 0;
    this.reported = 0;
    this.confirmed = 0;
  }
}
