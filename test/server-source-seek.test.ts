import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { objectArrowCallbackCode, parseTypeScriptSource } from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);

test('server retains Source seek authority and mapping classification before its effects', () => {
  const block = objectArrowCallbackCode(server, 'infrastructureEventProtocol', 'sourceSeeked');
  assert.match(block, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(block, /sourceRuntime\.canReportSeek\(socket\)/);
  assert.match(block, /robotContentTransitionRuntime\.clearPendingBoundary\(\)/);
  assert.match(block, /payload\.reason === 'follower-correction'/);
  assert.match(block, /calibrationContext\(\)/);
  assert.match(block, /robotContentTimeline\.currentDeltaMs/);
  assert.match(block, /robotContentTimeline\.referenceDeltaMs/);
  assert.match(block, /robotContentTimeline\.noteFollowerCorrection\(/);
  assert.match(block, /sourceSeekClassified\(\{/);

  assert.doesNotMatch(block, /robotPlayerOffset\.reset\(\)/);
  assert.doesNotMatch(block, /clearRobotContentTransition\(\)/);
  assert.doesNotMatch(block, /sourceRuntime\.invalidateMapping\(\)/);
  assert.doesNotMatch(block, /clearContentValidationBaseline\(\)/);
  assert.doesNotMatch(block, /calibration\.discardPrimedContent\(\)/);
  assert.doesNotMatch(block, /robotContentTimeline\.reset\(\)/);
  assert.doesNotMatch(block, /calibration\.fail\(/);
  assert.doesNotMatch(block, /syncAppliedCalibration\(\)/);
});
