import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function functionBlock(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = server.indexOf('\nfunction ', start + 1);
  return server.slice(start, next === -1 ? server.length : next);
}

test('Boot Probe scheduler reconciles stale Mic leg before policy admission', () => {
  const block = functionBlock('maybeStartProbeCalibration');
  const stale = block.indexOf('bootProbeRuntime.micLegStaleForContext(context)');
  const abandon = block.indexOf('abandonProbeRun()');
  const authority = block.indexOf('bootProbeStartAuthorityAllowsAttempt({');
  assert.ok(stale >= 0, 'stale Mic evidence must still be detected');
  assert.ok(abandon > stale, 'stale run must be abandoned after stale-evidence detection');
  assert.ok(authority > abandon, 'policy must sample reconciled Boot Probe state');
  assert.match(block, /const hasMicLeg = bootProbeRuntime\.hasMicLeg;/);
  assert.doesNotMatch(
    block,
    /bootProbeRuntime\.micLeg/,
    'scheduler decisions must not extract a Mic evidence copy from the aggregate',
  );
});

test('Boot Probe scheduler preserves lazy stale and lifecycle sampling order', () => {
  const block = functionBlock('maybeStartProbeCalibration');
  assert.match(
    block,
    /calibrationStale:\s*candidateIsBootProbe && hasCalibrationResult\s*\? calibrationIsStale\(\)\s*:\s*false/,
  );
  const authority = block.indexOf('bootProbeStartAuthorityAllowsAttempt({');
  const lifecycle = block.indexOf('if (!bootProbeRuntime.lifecycleIdle) return;');
  const status = block.indexOf('const probeErrored = probeStatus(nowMs).error !== null');
  const completed = block.indexOf('bootProbeRuntime.completedContextMatches(context)');
  const target = block.indexOf('selectBootProbeStartTarget({');
  assert.ok(authority >= 0);
  assert.ok(lifecycle > authority, 'lifecycle slot is sampled only after authority admission');
  assert.ok(status > lifecycle, 'probe status is not sampled while request/analysis work is pending');
  assert.doesNotMatch(
    block,
    /bootProbeRuntime\.pendingAnalysis|bootProbeStartLifecycleIdle/,
    'scheduler must query aggregate lifecycle idleness instead of reconstructing it',
  );
  assert.ok(completed > status, 'completed-context dedupe remains after probe error sampling');
  assert.ok(target > completed, 'logical target selection consumes the sampled facts');
});

test('retry cadence and transport/request effects remain server-owned and ordered', () => {
  const block = functionBlock('maybeStartProbeCalibration');
  const target = block.indexOf('selectBootProbeStartTarget({');
  const retry = block.indexOf('bootProbeRuntime.canStart(target, nowMs)');
  const path = block.indexOf('probePathReady(target, nowMs)');
  const send = block.indexOf('sendProbeRequest(target, nowMs)');
  assert.ok(target >= 0);
  assert.ok(retry > target, 'BootProbeRuntime keeps retry/attempt authority');
  assert.ok(path > retry, 'transport readiness remains after lifecycle cadence');
  assert.ok(send > path, 'request mutation happens only after both gates pass');
});
