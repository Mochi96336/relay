import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-robot-content-mapping-revocation-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-content-mapping-revocation-coordinator.ts', import.meta.url), 'utf8'),
);

test('revokeRobotContentMapping delegates cross-runtime teardown ordering', () => {
  const revoke = functionCode(server, 'revokeRobotContentMapping');
  assert.match(revoke, /robotContentMappingRevocationCoordinator\.revoke\(reason\)/);
  for (const step of [
    /robotPlayerOffset\.reset\(/,
    /robotContentTimeline\.reset\(/,
    /clearRobotContentTransition\(/,
    /sourceRuntime\.invalidateMapping\(/,
    /calibration\.discardPrimedContent\(/,
    /clearContentValidationBaseline\(/,
    /calibration\.fail\(/,
    /syncAppliedCalibration\(/,
    /broadcastJson\(/,
  ]) {
    assert.doesNotMatch(revoke, step, 'teardown effects belong to the coordinator seam');
  }
});

test('server composition retains Robot mapping and calibration authority', () => {
  assert.ok(
    importSources(server).includes('./relay-robot-content-mapping-revocation-coordinator.js'),
  );
  const composition = variableInitializerCode(server, 'robotContentMappingRevocationCoordinator');
  assert.match(composition, /^createRelayRobotContentMappingRevocationCoordinator\(\{/);
  assert.match(composition, /resetPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(composition, /resetContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(composition, /clearContentTransition: \(\) => clearRobotContentTransition\(\)/);
  assert.match(composition, /invalidateSourceMapping: \(\) => sourceRuntime\.invalidateMapping\(\)/);
  assert.match(composition, /discardPrimedContent: \(\) => calibration\.discardPrimedContent\(\)/);
  assert.match(composition, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(composition, /abortCalibrationIfCollecting: \(reason\) => \{/);
  assert.match(composition, /if \(calibration\.collecting\) calibration\.fail\(reason\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(composition, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(
    composition,
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/,
  );
  assert.doesNotMatch(
    composition,
    /bootProbeRuntime/,
    'the wall-time boot baseline deliberately survives media mapping revocation',
  );
});

test('Robot mapping revocation coordinator owns ordering only, not runtime authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(coordinatorCode, /^import /m);
  assert.doesNotMatch(
    coordinatorCode,
    /RobotPlayerOffsetTracker|RobotContentTimelineMapper|RobotContentTransitionRuntime|SourceRuntime|CalibrationSession|ContentCalibrationValidator|bootProbeRuntime|broadcastJson/,
  );
});
