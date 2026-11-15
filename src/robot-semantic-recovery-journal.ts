import { readFile, writeFile } from 'node:fs/promises';

/**
 * Which semantic recovery runs reach the journal.
 *
 * The timer runs recovery every ~12 s. On 2026-11-12 its healthy passes, one
 * JSON line each plus systemd's start and finish lines, were 97% of the
 * journal's text, and the 500 MB cap was rotating Relay's own evidence out
 * after about three weeks. A healthy run that matches the last line it would
 * have written says nothing new: it is counted, and the count is written with
 * the next line. That line comes when anything changes, on any run that is not
 * routine, and at least once an hour as a heartbeat.
 */
export const RECOVERY_JOURNAL_HEARTBEAT_MS = 60 * 60_000;

export type RecoveryJournalMark = {
  /** What the last journaled run looked like. */
  key: string;
  loggedAtMs: number;
  /** Routine runs left out of the journal since that line. */
  quietRuns: number;
};

export type RecoveryJournalVerdict = {
  write: boolean;
  /** Routine runs left out since the previous line, reported on this one. */
  quietRuns: number;
  next: RecoveryJournalMark;
};

export function recoveryJournalVerdict(
  previous: RecoveryJournalMark | null,
  run: { key: string; routine: boolean; nowMs: number },
  heartbeatMs = RECOVERY_JOURNAL_HEARTBEAT_MS,
): RecoveryJournalVerdict {
  const quiet = previous !== null
    && run.routine
    && previous.key === run.key
    // Uptime restarts at zero after a reboot; a clock behind the mark is a new boot.
    && run.nowMs >= previous.loggedAtMs
    && run.nowMs - previous.loggedAtMs < heartbeatMs;
  if (quiet) {
    return { write: false, quietRuns: previous.quietRuns + 1, next: { ...previous, quietRuns: previous.quietRuns + 1 } };
  }
  return {
    write: true,
    quietRuns: previous?.quietRuns ?? 0,
    next: { key: run.key, loggedAtMs: run.nowMs, quietRuns: 0 },
  };
}

/** Where the mark lives: beside the recovery state, in the runtime directory. */
export function recoveryJournalMarkPath(stateFile: string) {
  return `${stateFile}.journal`;
}

/** A missing or unreadable mark journals the run: losing it can only add a line. */
export async function readRecoveryJournalMark(file: string): Promise<RecoveryJournalMark | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<RecoveryJournalMark>;
    if (typeof value.key !== 'string' || !Number.isFinite(value.loggedAtMs)
      || !Number.isSafeInteger(value.quietRuns) || Number(value.quietRuns) < 0) return null;
    return { key: value.key, loggedAtMs: Number(value.loggedAtMs), quietRuns: Number(value.quietRuns) };
  } catch {
    return null;
  }
}

/** Never fails the run: a mark that cannot be written only costs a journal line. */
export async function writeRecoveryJournalMark(file: string, mark: RecoveryJournalMark) {
  try {
    await writeFile(file, `${JSON.stringify(mark)}\n`, 'utf8');
  } catch {
    // The next run reads no mark and journals itself.
  }
}
