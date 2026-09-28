import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('offline Listen catch-up A/B exercises the real Worklet and a gated candidate', () => {
  const child = spawnSync(
    process.execPath,
    ['scripts/listen-catchup-ab.mjs', '--self-test'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.current.mode, 'current');
  assert.equal(report.candidate.mode, 'candidate');
  assert.ok(report.current.trimmedMs > 0);
  assert.ok(report.candidate.trimEvents.length > 0);
  assert.equal(report.current.droppedMs, report.candidate.droppedMs);
  assert.equal(report.current.outputSamples, report.candidate.outputSamples);
});
