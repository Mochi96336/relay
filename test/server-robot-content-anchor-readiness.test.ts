import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function functionBlock(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = server.indexOf('\nfunction ', start + 1);
  return server.slice(start, next === -1 ? server.length : next);
}

test('Robot follower preservation requires proven content authority or enough in-flight pre-seek evidence', () => {
  const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));
  const gate = functionCode(mapping, 'followerSeekMayPreserveMapping');
  assert.match(gate, /dependencies\.timeline\.isReady\(context, nowMs\)/);
  assert.match(gate, /dependencies\.queries\.appliedKind\(\) === 'content'/);
  assert.match(gate, /dependencies\.calibration\.confirmedResult !== null/);
  assert.match(gate, /!dependencies\.queries\.calibrationIsStale\(\)/);
  assert.match(gate, /dependencies\.timing\.calibrationKind !== 'content' \|\| !dependencies\.calibration\.collecting/);
  assert.match(gate, /dependencies\.calibration\.transitionEvidence\(dependencies\.transitionHistorySamples\)/);
  // Usability is a named policy with its own unit tests rather than a length
  // check inlined here: length is span, and a window that is mostly capture
  // hole would otherwise pass and then strand the transition at windows=0.
  assert.match(gate, /robotContentAnchorEvidenceUsable\(/);
  assert.match(gate, /dependencies\.maxCaptureGapMs/, 'the transition must use the injected calibration gap bound');
  assert.match(functionBlock('robotFollowerSeekMayPreserveMapping'), /relayRobotMapping\.followerSeekMayPreserveMapping\(nowMs\)/);
  assert.doesNotMatch(
    gate,
    /needsBackingBoundary/,
    'a repeated mapped correction must not become destructive merely because the prior boundary is still pending',
  );
});

test('Robot transition compare windows use AudioSession range evidence and the calibration gap bound', () => {
  const construction = server.slice(
    server.indexOf('const robotContentTransitionRuntime = new RobotContentTransitionRuntime({'),
    server.indexOf('function robotFollowerSeekMayPreserveMapping'),
  );
  assert.match(construction, /maxEvidenceGapMs: MAX_CAPTURE_GAP_MS/);
  assert.match(
    construction,
    /readBackingEvidence: \(start, length\) => session\.readBackingEvidence\(start, length\)/,
  );
  assert.match(
    construction,
    /readMicEvidence: \(start, length\) => session\.readMicEvidence\(start, length\)/,
  );
});

test('server uses content anchor authority only to preserve a follower seek, not to permit the seek itself', () => {
  assert.match(
    server,
    /const mappedFollowerCorrection = requestedFollowerCorrection[\s\S]*?robotFollowerSeekMayPreserveMapping\(nowMs\)[\s\S]*?robotContentTimeline\.noteFollowerCorrection/,
  );
});

test('source-status publishes the server-owned follower-seek authority fact', () => {
  const status = functionBlock('sourceStatusPayload');
  assert.match(
    status,
    /robotFollowerSeekPreservesMapping: robotFollowerSeekMayPreserveMapping\(nowMs\)/,
  );
});
