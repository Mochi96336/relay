import type { CalibrationApplicability, CalibrationAuthorityKind } from './calibration-applicability.js';

export type CalibrationAuthorityEntry = {
  kind: CalibrationAuthorityKind;
  applicability: CalibrationApplicability;
  /** The calibrated lag the mixer holds; null when none is applied. */
  appliedMs: number | null;
};

/**
 * When the calibration that places the voice is worth a journal line: its
 * kind or applicability changed, a lag was applied or withdrawn, or the lag
 * moved this far since the last line.
 *
 * On 2026-11-03 an applied content calibration was withdrawn after 12 s and
 * applied again 7 s later, and each change jumped the read head over the
 * singer's voice. The journal showed the jumps and nothing of the decision
 * behind them. Each line carries the inputs of that decision.
 */
export class CalibrationAuthorityJournal {
  private last: (CalibrationAuthorityEntry & { atMs: number }) | null = null;
  constructor(private readonly moveMs = 20, private readonly intervalMs = 1000) {}

  note(entry: CalibrationAuthorityEntry, nowMs: number): 'start' | 'authority' | 'move' | null {
    const last = this.last;
    const change = !last ? 'start'
      : last.kind !== entry.kind || last.applicability !== entry.applicability
        || (last.appliedMs === null) !== (entry.appliedMs === null) ? 'authority'
      : entry.appliedMs !== null && last.appliedMs !== null
        && Math.abs(entry.appliedMs - last.appliedMs) >= this.moveMs
        && nowMs - last.atMs >= this.intervalMs ? 'move'
      : null;
    if (change) this.last = { ...entry, atMs: nowMs };
    return change;
  }

  reset() { this.last = null; }
}
