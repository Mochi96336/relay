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
  new URL('../src/relay-live-source-stop-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-live-source-stop-coordinator.ts', import.meta.url), 'utf8'),
);
const application = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));

test('stopLiveSource delegates teardown ordering through the coordinator seam', () => {
  const stop = functionCode(server, 'stopLiveSource');
  assert.match(stop, /relayCalibrationLifecycle\.stopLiveSource\(\)/);
  assert.match(functionCode(application, 'stopLiveSource'), /liveSourceStopCoordinator\.stop\(\)/);
  assert.doesNotMatch(stop, /backingRuntime\./);
  assert.doesNotMatch(stop, /takeController\./);
  assert.doesNotMatch(stop, /clearBootCalibrationState\(/);
  assert.doesNotMatch(stop, /clearContentValidationBaseline\(/);
  assert.doesNotMatch(stop, /robotPlayerOffset\./);
  assert.doesNotMatch(stop, /robotContentTimeline\./);
  assert.doesNotMatch(stop, /clearRobotContentTransition\(/);
  assert.doesNotMatch(stop, /session\./);
  assert.doesNotMatch(stop, /calibration\./);
  assert.doesNotMatch(stop, /timingRuntime\./);
  assert.doesNotMatch(stop, /broadcastJson\(/);
  assert.doesNotMatch(stop, /broadcastStatus\(/);
});

test('server composition retains every live source teardown domain effect', () => {
  assert.ok(importSources(application).includes('./relay-live-source-stop-coordinator.js'));
  const composition = variableInitializerCode(application, 'liveSourceStopCoordinator');
  const binding = variableInitializerCode(server, 'relayCalibrationLifecycle');
  assert.match(composition, /^createRelayLiveSourceStopCoordinator\(\{/);
  assert.match(composition, /cancelBackingGrace: \(\) => backingRuntime\.cancelGrace\(\)/);
  assert.match(composition, /retireRobotRoute: \(\) => backingRuntime\.retireRobotRoute\(\)/);
  assert.match(composition, /sessionActive: \(\) => session\.active/);
  assert.match(composition, /endTakeMix: \(\) => effects\.endTakeMix\(\)/);
  assert.match(binding, /endTakeMix: \(\) => takeController\.endMix\(\)/);
  assert.match(composition, /clearBootCalibration: \(\) => clearBootCalibrationState\(\)/);
  assert.match(composition, /clearContentValidation: \(\) => commands\.clearContentValidation\(\)/);
  assert.match(binding, /clearContentValidation: clearContentValidationBaseline/);
  assert.match(functionCode(application, 'clearBootCalibrationState'), /bootProbeRuntime\.clear\(\)/);
  assert.match(composition, /resetRobotPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(composition, /resetRobotContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(
    composition,
    /clearRobotContentTransition: \(\) => commands\.clearRobotContentTransition\(\)/,
  );
  assert.match(composition, /stopSession: \(\) => session\.stop\(\)/);
  assert.match(composition, /resetCalibration: \(\) => calibration\.reset\(\)/);
  assert.match(composition, /clearTimingKind: \(\) => timingRuntime\.clearCalibrationKind\(\)/);
  assert.match(
    composition,
    /resetAutoCalibrationSchedule: \(\) => timingRuntime\.resetAutoCalibrationSchedule\(\)/,
  );
  assert.match(
    composition,
    /reportTimingStatus: \(\) => effects\.reportTimingStatus\(\)/,
  );
  assert.match(composition, /reportSourceStatus: \(\) => effects\.reportSourceStatus\(\)/);
  assert.match(composition, /reportStatus: \(\) => effects\.reportStatus\(\)/);
  assert.match(binding, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(binding, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(binding, /reportStatus: \(\) => broadcastStatus\(\)/);
});

test('live source stop coordinator owns ordering only, not server runtime authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(coordinatorCode, /^import /m);
  assert.doesNotMatch(
    coordinatorCode,
    /backingRuntime\.|session\.|takeController\.|calibration\.|timingRuntime\.|robotPlayerOffset\.|robotContentTimeline\.|broadcastJson|broadcastStatus\(/,
  );
});
