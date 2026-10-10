import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function analyze(patch: (row: any, i: number) => void = () => {}, count = 40) {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-shadow-report-'));
  try {
    const rows = Array.from({ length: count }, (_, i) => {
      const row = { at: new Date(1700000000000 + i * 1000).toISOString(), sessionGeneration: 1, micGeneration: 1,
        videoId: 'abcdefghijk', playbackRate: 1, calibrationKind: 'content', referenceMeasurementMs: -20,
        calibrationState: 'complete', provisional: false, takeLifecycle: 'idle', fresh: true, playing: true,
        calibrationStale: false, frontierMs: 0, faults: [], appliedMs: -20, requestedMs: -20,
        shadowMs: -25 as number | null, liveBootEstimateMs: -100, rttHalfMs: 10, micGapMs: 0,
        backingGapMs: 0, foldCount: 0, validation: { lastOutcome: 'stable', lastValidationAgeMs: 5000, baselineLagMs: -20 } };
      patch(row, i); return row;
    });
    const file = path.join(dir, 'rows.jsonl');
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n'));
    const run = spawnSync(process.execPath, ['scripts/sample-song-shadow-report.mjs', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('compares identical stable sample sets against Content and keeps trial counts honest', () => {
  const report = analyze((r, i) => { if (i === 20) r.shadowMs = null; });
  assert.equal(report.independentTrials.captures, 1);
  assert.equal(report.independentTrials.songs, 1);
  const s = report.segments[0];
  assert.equal(s.eligibleStableSamples, 35);
  assert.equal(s.matchedSamples, 34);
  assert.equal(s.errorsVsContent.shadow.absoluteMedianMs, 5);
  assert.equal(s.errorsVsContent.boot.absoluteMedianMs, 80);
  assert.equal(s.errorsVsContent.rtt.absoluteMedianMs, 30);
  assert.equal(s.errorsVsContent.shadow.n, s.errorsVsContent.boot.n);
});
test('does not call boot periods, stale validation or frozen recording a Content reference', () => {
  for (const patch of [
    (r: any) => { r.calibrationKind = 'boot-probe'; },
    (r: any) => { r.validation.lastOutcome = 'invalid'; },
    (r: any) => { r.validation.lastValidationAgeMs = 60001; },
    (r: any) => { r.validation.baselineLagMs = -100; },
    (r: any) => { r.takeLifecycle = 'recording'; },
    (r: any) => { r.micArriving = false; },
    (r: any) => { r.contentLiveTargetMs = null; },
  ]) assert.equal(analyze(patch).segments[0].matchedSamples, 0);
});
test('segments capture resets and excludes slewed read heads until settled', () => {
  const report = analyze((r, i) => {
    if (i >= 40) r.micGeneration = 2;
    if (i < 10) r.appliedMs = r.requestedMs = -100 + i * 8;
  }, 80);
  assert.equal(report.segments.length, 2);
  assert.equal(report.independentTrials.captures, 2);
  assert.ok(report.segments[0].excluded.settling >= 15);
});


test('does not compare Boot with itself when a Content label inherits its read head', () => {
  const ambiguous = analyze(r => { r.bootStoredMs = r.appliedMs; });
  assert.equal(ambiguous.segments[0].matchedSamples, 0);
  assert.equal(ambiguous.segments[0].ambiguousInheritedBootSamples, 40);
  const explicit = analyze(r => { r.bootStoredMs = r.appliedMs; r.contentLiveTargetMs = -30; });
  assert.equal(explicit.segments[0].matchedSamples, 35);
  assert.equal(explicit.segments[0].errorsVsContent.shadow.signedMedianMs, 5);
  assert.equal(explicit.segments[0].errorsVsContent.boot.signedMedianMs, -70);
  assert.equal(explicit.segments[0].targetReferenceSamples, 35);
});
