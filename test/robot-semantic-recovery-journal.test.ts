import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RECOVERY_JOURNAL_HEARTBEAT_MS,
  readRecoveryJournalMark,
  recoveryJournalMarkPath,
  recoveryJournalVerdict,
  writeRecoveryJournalMark,
} from '../src/robot-semantic-recovery-journal.js';

const healthy = (nowMs: number) => ({ key: 'healthy', routine: true, nowMs });

test('routine healthy runs are counted, not journaled, until the hourly heartbeat', () => {
  let mark = null;
  const first = recoveryJournalVerdict(mark, healthy(1_000));
  assert.equal(first.write, true, 'the first run after boot or a lost mark is journaled');
  mark = first.next;
  // About 300 runs an hour at the timer's pace: none of them reaches the journal.
  for (let i = 1; i < 300; i++) {
    const run = recoveryJournalVerdict(mark, healthy(1_000 + i * 12_000));
    assert.equal(run.write, false);
    mark = run.next;
  }
  assert.equal(mark.quietRuns, 299);
  const heartbeat = recoveryJournalVerdict(mark, healthy(1_000 + RECOVERY_JOURNAL_HEARTBEAT_MS));
  assert.equal(heartbeat.write, true);
  assert.equal(heartbeat.quietRuns, 299, 'the heartbeat says how many runs it stands for');
  assert.deepEqual(heartbeat.next, { key: 'healthy', loggedAtMs: 1_000 + RECOVERY_JOURNAL_HEARTBEAT_MS, quietRuns: 0 });
});

test('a change, a non-routine run, or a new boot is journaled at once', () => {
  const mark = { key: 'healthy', loggedAtMs: 50_000, quietRuns: 7 };
  const changed = recoveryJournalVerdict(mark, { key: 'grace', routine: true, nowMs: 60_000 });
  assert.equal(changed.write, true);
  assert.equal(changed.quietRuns, 7);
  assert.equal(recoveryJournalVerdict(mark, { key: 'healthy', routine: false, nowMs: 60_000 }).write, true,
    'a restart, an error or a fault is always journaled, even with the same key');
  assert.equal(recoveryJournalVerdict(mark, healthy(10_000)).write, true,
    'uptime behind the mark is a reboot');
  // Back to healthy after a fault: journaled, since the last line said otherwise.
  const recovered = recoveryJournalVerdict(changed.next, healthy(72_000));
  assert.equal(recovered.write, true);
});

test('the mark lives beside the state file and a bad one only costs a line', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recovery-journal-'));
  try {
    const file = recoveryJournalMarkPath(path.join(dir, 'state.json'));
    assert.equal(file, path.join(dir, 'state.json.journal'));
    assert.equal(await readRecoveryJournalMark(file), null, 'missing');
    await writeRecoveryJournalMark(file, { key: 'healthy', loggedAtMs: 5, quietRuns: 2 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { key: 'healthy', loggedAtMs: 5, quietRuns: 2 });
    assert.deepEqual(await readRecoveryJournalMark(file), { key: 'healthy', loggedAtMs: 5, quietRuns: 2 });
    for (const bad of ['{', '{"key":1,"loggedAtMs":5,"quietRuns":0}', '{"key":"a","loggedAtMs":5,"quietRuns":-1}']) {
      writeFileSync(file, bad);
      assert.equal(await readRecoveryJournalMark(file), null, bad);
    }
    await writeRecoveryJournalMark(path.join(dir, 'missing-dir', 'x'), { key: 'k', loggedAtMs: 0, quietRuns: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the live entry journals through the gate and keeps its exit codes outside it', () => {
  const entry = readFileSync(new URL('../src/robot-semantic-recovery-live-entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /if \(journal\.write\) process\.stdout\.write\(/);
  assert.doesNotMatch(entry, /if \(!journal\.write\) return/);
  assert.ok(entry.indexOf('writeRecoveryJournalMark(') < entry.indexOf('if (journal.write)'));
  assert.ok(entry.indexOf('process.exitCode = 2') > entry.indexOf('if (journal.write)'));
  assert.match(entry, /quietRuns: journal\.quietRuns/);
});
