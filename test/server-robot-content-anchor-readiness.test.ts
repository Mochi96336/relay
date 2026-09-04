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

test('Robot follower preservation requires proven content authority or enough in-flight pre-seek evidence', () => {
  const gate = functionBlock('robotFollowerSeekMayPreserveMapping');
  assert.match(gate, /robotContentTimeline\.isReady\(context, nowMs\)/);
  assert.match(gate, /appliedCalibrationKind\(\) === 'content'/);
  assert.match(gate, /calibration\.confirmedResult !== null/);
  assert.match(gate, /!calibrationIsStale\(\)/);
  assert.match(gate, /timingRuntime\.calibrationKind !== 'content' \|\| !calibration\.collecting/);
  assert.match(gate, /calibration\.transitionEvidence\(ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES\)/);
  // Usability is a named policy with its own unit tests rather than a length
  // check inlined here: length is span, and a window that is mostly capture
  // hole would otherwise pass and then strand the transition at windows=0.
  assert.match(gate, /robotContentAnchorEvidenceUsable\(/);
  assert.match(gate, /MAX_CAPTURE_GAP_MS/, 'the transition must use the same gap bound calibration enforces');
  assert.doesNotMatch(
    gate,
    /needsBackingBoundary/,
    'a repeated mapped correction must not become destructive merely because the prior boundary is still pending',
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
