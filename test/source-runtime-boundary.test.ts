import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const runtime = parseTypeScriptSource(
  new URL('../src/source-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/source-runtime.ts', import.meta.url), 'utf8'),
);
const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('SourceRuntime owns source identity without absorbing mapping or product effects', () => {
  const runtimeCode = sourceCode(runtime);
  const serverCode = sourceCode(server);
  const sourceRuntime = variableInitializerCode(server, 'sourceRuntime');

  assert.deepEqual(importSources(runtime), [], 'SourceRuntime must stay dependency-free');
  assert.match(sourceRuntime, /^new SourceRuntime<RelaySocket>/);
  assert.match(serverCode, /sourceGeneration: sourceRuntime\.generation/);
  assert.match(serverCode, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(serverCode, /sourceRuntime\.detachRobot\(socket\)/);
  assert.match(serverCode, /sourceRuntime\.invalidateMapping\(\)/);
  assert.match(serverCode, /sourceRuntime\.canReportSeek\(socket\)/);

  assert.doesNotMatch(serverCode, /let activeRobotSource: RelaySocket \| null/);
  assert.doesNotMatch(serverCode, /let sourceGeneration =/);
  assert.doesNotMatch(serverCode, /sourceGeneration \+= 1/);

  // Domain consequences remain explicit in server orchestration, even when
  // their ordering is delegated through a coordinator callback seam.
  assert.match(serverCode, /noteQualityEvent: \(event\) => takeController\.noteQualityEvent\(event\)/);
  assert.match(serverCode, /robotPlayerOffset\.reset\(\)/);
  assert.match(serverCode, /robotContentTimeline\.reset\(\)/);
  assert.match(serverCode, /calibration\.discardPrimedContent\(\)/);
  assert.doesNotMatch(runtimeCode, /noteQualityEvent|discardPrimedContent|sendJson|broadcastJson/);
});
