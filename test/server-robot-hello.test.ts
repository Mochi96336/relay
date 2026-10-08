import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { objectArrowCallbackCode, parseTypeScriptSource } from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('Robot hello keeps infrastructure and SourceRuntime attach authority in server', () => {
  const hello = objectArrowCallbackCode(server, 'robotLifecycleProtocol', 'robotSourceHello');
  assert.match(hello, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(hello, /sourceRuntime\.isActive\(socket\)/);
  assert.match(hello, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(hello, /robotSourceActivated\(previous, replaced\)/);

  assert.doesNotMatch(hello, /takeController\.noteQualityEvent\(/);
  assert.doesNotMatch(hello, /abandonProbeRun\(\)/);
  assert.doesNotMatch(hello, /robotPlayerOffset\.reset\(\)/);
  assert.doesNotMatch(hello, /robotContentTimeline\.reset\(\)/);
  assert.doesNotMatch(hello, /clearRobotContentTransition\(\)/);
  assert.doesNotMatch(hello, /dropLegacyCalibrationForRobot\(\)/);
  assert.doesNotMatch(hello, /syncAppliedCalibration\(\)/);
  assert.doesNotMatch(hello, /broadcastJson\(/);
});
