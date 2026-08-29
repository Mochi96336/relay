import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'src/source-runtime.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

test('SourceRuntime owns source identity without absorbing mapping or product effects', () => {
  assert.doesNotMatch(runtime, /^import /m, 'SourceRuntime must stay dependency-free');
  assert.match(server, /new SourceRuntime<RelaySocket>/);
  assert.match(server, /sourceGeneration: sourceRuntime\.generation/);
  assert.match(server, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(server, /sourceRuntime\.detachRobot\(socket\)/);
  assert.match(server, /sourceRuntime\.invalidateMapping\(\)/);
  assert.match(server, /sourceRuntime\.canReportSeek\(socket\)/);

  assert.doesNotMatch(server, /let activeRobotSource: RelaySocket \| null/);
  assert.doesNotMatch(server, /let sourceGeneration =/);
  assert.doesNotMatch(server, /sourceGeneration \+= 1/);

  // Domain consequences remain explicit in server orchestration.
  assert.match(server, /takeController\.noteQualityEvent\('robot-source-replaced'\)/);
  assert.match(server, /robotPlayerOffset\.reset\(\)/);
  assert.match(server, /robotContentTimeline\.reset\(\)/);
  assert.match(server, /calibration\.discardPrimedContent\(\)/);
  assert.doesNotMatch(runtime, /noteQualityEvent|discardPrimedContent|sendJson|broadcastJson/);
});
