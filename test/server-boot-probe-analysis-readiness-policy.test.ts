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

test('Boot Probe analysis readiness delegates identity/deadline/window precedence', () => {
  const block = functionBlock('maybeFinishProbeAnalysis');
  assert.match(block, /decideBootProbeAnalysisReadiness\(\{/);
  assert.match(
    block,
    /const sessionCurrent = session\.active\s*&& waiting\.sessionGeneration === session\.generation/,
  );
  assert.match(
    block,
    /const captureGenerationMatches = sessionCurrent\s*\? probeGeneration\(waiting\.target\) === waiting\.generation\s*:\s*false/,
    'capture generation must not be sampled after the run identity is already stale',
  );
  assert.match(block, /nowMs,\s*deadlineMs: waiting\.deadlineMs/);
  assert.match(block, /reachedSamples: reached,\s*neededSamples: needed/);
});

test('stale analysis settlement effects remain server-owned', () => {
  const block = functionBlock('maybeFinishProbeAnalysis');
  const decision = block.indexOf('decideBootProbeAnalysisReadiness({');
  const abandonBranch = block.indexOf("if (readiness.kind === 'abandon')");
  const abandon = block.indexOf('abandonProbeRun()', abandonBranch);
  const report = block.indexOf('broadcastJson(timingCalibrationStatusPayload())', abandonBranch);
  assert.ok(decision >= 0);
  assert.ok(abandonBranch > decision);
  assert.ok(abandon > abandonBranch);
  assert.ok(report > abandon);
  assert.match(
    block,
    /readiness\.reason === 'capture-generation' && PROBE_DEBUG/,
    'only capture-generation abandonment keeps the old debug message',
  );
});

test('timeout consumes analysis before failing the attempt and ready is the only DSP path', () => {
  const block = functionBlock('maybeFinishProbeAnalysis');
  const timeoutBranch = block.indexOf("if (readiness.kind === 'timeout')");
  const timeoutTake = block.indexOf('bootProbeRuntime.takeAnalysis()', timeoutBranch);
  const fail = block.indexOf("failProbeAttempt(waiting.target, 'captured audio did not reach the analyzer before timeout', nowMs)", timeoutBranch);
  const waitBranch = block.indexOf("if (readiness.kind === 'wait') return");
  const readyTake = block.indexOf('const analysis = bootProbeRuntime.takeAnalysis()', waitBranch);
  const evidenceRead = block.indexOf("const rangeEvidence = analysis.target === 'mic'", readyTake);
  const evidenceDecision = block.indexOf('decideBootProbeAnalysisEvidence({', evidenceRead);
  const evidenceReject = block.indexOf("if (evidenceDecision.kind === 'reject')", evidenceDecision);
  const gapFailure = block.indexOf('failProbeAttempt(analysis.target, reason, nowMs)', evidenceReject);
  const dsp = block.indexOf('locateProbe(window, MIX_SAMPLE_RATE)', gapFailure);
  assert.ok(timeoutBranch >= 0);
  assert.ok(timeoutTake > timeoutBranch);
  assert.ok(fail > timeoutTake, 'timeout must consume lifecycle analysis before failAttempt');
  assert.ok(waitBranch > fail, 'wait remains after timeout precedence');
  assert.ok(readyTake > waitBranch, 'only ready state consumes analysis for evidence/DSP');
  assert.ok(evidenceRead > readyTake, 'range evidence must be sampled only after ready consumes analysis');
  assert.ok(evidenceDecision > evidenceRead, 'the shared evidence policy must consume AudioSession facts');
  assert.ok(evidenceReject > evidenceDecision, 'sparse evidence must be rejected before DSP');
  assert.ok(gapFailure > evidenceReject, 'a sparse window must fail the bounded probe attempt');
  assert.ok(dsp > gapFailure, 'locateProbe must never see a rejected zero-filled window');
  assert.match(block, /session\.readMicEvidence\(analysis\.windowStart, analysis\.windowSamples\)/);
  assert.match(block, /session\.readBackingEvidence\(analysis\.windowStart, analysis\.windowSamples\)/);
  assert.match(block, /maxGapMs:\s*MAX_CAPTURE_GAP_MS/);
});
