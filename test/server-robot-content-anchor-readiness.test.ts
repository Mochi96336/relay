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

test('Robot follower seek requires fresh confirmed content authority before it can create quarantine', () => {
  const gate = functionBlock('robotContentTransitionAnchorReady');
  assert.match(gate, /robotContentTimeline\.isReady\(context, nowMs\)/);
  assert.match(gate, /!robotContentTimeline\.needsBackingBoundary\(context\)/);
  assert.match(gate, /timingRuntime\.calibrationKind === 'content'/);
  assert.match(gate, /calibration\.confirmedResult !== null/);
  assert.match(gate, /!calibrationIsStale\(\)/);
  assert.doesNotMatch(
    gate,
    /transitionEvidence|readBacking|readMic/,
    'seek permission must use already-confirmed authority, not speculative post-seek discovery',
  );
});

test('source-status publishes the server-owned follower-seek authority fact', () => {
  const status = functionBlock('sourceStatusPayload');
  assert.match(
    status,
    /robotContentTransitionAnchorReady: robotContentTransitionAnchorReady\(nowMs\)/,
  );
});
