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
  const gate = functionBlock('robotContentTransitionAnchorReady');
  assert.match(gate, /robotContentTimeline\.isReady\(context, nowMs\)/);
  assert.match(gate, /appliedCalibrationKind\(\) === 'content'/);
  assert.match(gate, /calibration\.confirmedResult !== null/);
  assert.match(gate, /!calibrationIsStale\(\)/);
  assert.match(gate, /timingRuntime\.calibrationKind !== 'content' \|\| !calibration\.collecting/);
  assert.match(gate, /calibration\.transitionEvidence\(ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES\)/);
  assert.match(gate, /evidence\.mic\.length > MIX_SAMPLE_RATE/);
  assert.match(gate, /evidence\.backing\.length > MIX_SAMPLE_RATE/);
  assert.doesNotMatch(
    gate,
    /needsBackingBoundary/,
    'a repeated mapped correction must not become destructive merely because the prior boundary is still pending',
  );
});

test('server uses content anchor authority only to preserve a follower seek, not to permit the seek itself', () => {
  assert.match(
    server,
    /const mappedFollowerCorrection = requestedFollowerCorrection[\s\S]*?robotContentTransitionAnchorReady\(nowMs\)[\s\S]*?robotContentTimeline\.noteFollowerCorrection/,
  );
});

test('source-status publishes the server-owned follower-seek authority fact', () => {
  const status = functionBlock('sourceStatusPayload');
  assert.match(
    status,
    /robotContentTransitionAnchorReady: robotContentTransitionAnchorReady\(nowMs\)/,
  );
});
