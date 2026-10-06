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
const mapping = parseTypeScriptSource(
  new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'),
);

test('revokeRobotContentMapping delegates cross-runtime teardown ordering', () => {
  const revoke = functionCode(server, 'revokeRobotContentMapping');
  assert.match(revoke, /relayRobotMapping\.revoke\(reason\)/);
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
    importSources(mapping).includes('./relay-robot-content-mapping-revocation-coordinator.js'),
  );
  assert.ok(importSources(server).includes('./relay-robot-mapping-orchestration.js'));
  const composition = variableInitializerCode(mapping, 'revocation');
  assert.match(composition, /^createRelayRobotContentMappingRevocationCoordinator\(\{/);
  assert.match(composition, /resetPlayerOffset: \(\) => dependencies\.offset\.reset\(\)/);
  assert.match(composition, /resetContentTimeline: \(\) => dependencies\.timeline\.reset\(\)/);
  assert.match(composition, /clearContentTransition: \(\) => clearTransition\(\)/);
  assert.match(composition, /invalidateSourceMapping: \(\) => dependencies\.source\.invalidateMapping\(\)/);
  assert.match(composition, /discardPrimedContent: \(\) => dependencies\.calibration\.discardPrimedContent\(\)/);
  assert.match(composition, /clearContentValidation: \(\) => dependencies\.effects\.clearContentValidation\(\)/);
  assert.match(composition, /abortCalibrationIfCollecting: \(reason\) => \{/);
  assert.match(composition, /if \(dependencies\.calibration\.collecting\) dependencies\.calibration\.fail\(reason\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ dependencies\.effects\.syncAppliedCalibration\(\); \}/);
  assert.match(composition, /reportSourceStatus: \(\) => dependencies\.effects\.reportSourceStatus\(\)/);
  assert.match(
    composition,
    /reportTimingStatus: \(\) => dependencies\.effects\.reportTimingStatus\(\)/,
  );
  const production = variableInitializerCode(server, 'relayRobotMapping');
  for (const binding of ['offset: robotPlayerOffset', 'timeline: robotContentTimeline',
    'source: sourceRuntime', 'calibration,', 'transition: robotContentTransitionRuntime',
    'clearContentValidation: clearContentValidationBaseline']) assert.ok(production.includes(binding));
  assert.match(production, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(production, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(production, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
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
