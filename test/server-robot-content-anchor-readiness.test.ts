import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');

function functionBlock(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = server.indexOf('\nfunction ', start + 1);
  return server.slice(start, next === -1 ? server.length : next);
}

test('Robot follower correction readiness requires full safe pre-seek evidence unless content authority already exists', () => {
  const block = functionBlock('robotContentTransitionAnchorReady');
  assert.match(block, /robotContentTimeline\.needsBackingBoundary\(context\)/);
  assert.match(block, /timingRuntime\.calibrationKind === 'content'/);
  assert.match(block, /calibration\.confirmedResult !== null/);
  assert.match(block, /calibration\.transitionEvidenceSpanSamples >= ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES/);
});

test('source-status owns the seek-readiness fact and Robot Source consumes it before seekTo', () => {
  const status = functionBlock('sourceStatusPayload');
  assert.match(status, /robotContentTransitionAnchorReady: robotContentTransitionAnchorReady\(nowMs\)/);
  const gate = source.indexOf('latestSourceStatus?.robotContentTransitionAnchorReady === true');
  const seek = source.indexOf('player.seekTo(seekTarget, true)');
  assert.ok(gate >= 0 && seek > gate, 'server readiness must gate the actual follower seek');
});
