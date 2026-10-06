import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  objectArrowCallbackCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-robot-activation-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-activation-coordinator.ts', import.meta.url), 'utf8'),
);
const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));

test('Robot hello keeps infrastructure and SourceRuntime attach authority in server', () => {
  const hello = objectArrowCallbackCode(server, 'robotLifecycleProtocol', 'robotSourceHello');
  assert.match(hello, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(hello, /sourceRuntime\.isActive\(socket\)/);
  assert.match(hello, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(hello, /relayRobotMapping\.activateSource\(\{ previous, replaced \}\)/);

  assert.doesNotMatch(hello, /takeController\.noteQualityEvent\(/);
  assert.doesNotMatch(hello, /abandonProbeRun\(\)/);
  assert.doesNotMatch(hello, /robotPlayerOffset\.reset\(\)/);
  assert.doesNotMatch(hello, /robotContentTimeline\.reset\(\)/);
  assert.doesNotMatch(hello, /clearRobotContentTransition\(\)/);
  assert.doesNotMatch(hello, /dropLegacyCalibrationForRobot\(\)/);
  assert.doesNotMatch(hello, /syncAppliedCalibration\(\)/);
  assert.doesNotMatch(hello, /broadcastJson\(/);
});

test('server composition retains Robot activation effects', () => {
  assert.ok(importSources(mapping).includes('./relay-robot-activation-coordinator.js'));
  const composition = variableInitializerCode(mapping, 'activation');
  const binding = variableInitializerCode(server, 'relayRobotMapping');
  assert.match(composition, /^createRelayRobotActivationCoordinator<TSocket>/);
  assert.match(composition, /dependencies\.effects\.notifyPreviousReplaced\(previous\)/);
  assert.match(binding, /notifyPreviousReplaced: \(previous\) => sendJson\(previous, \{ type: 'robot-source-replaced' \}\)/);
  assert.match(composition, /dependencies\.take\.noteQualityEvent\(event\)/);
  assert.match(composition, /abandonProbeRun: \(\) => dependencies\.commands\.abandonProbeRun\(\)/);
  assert.match(composition, /sessionActive: \(\) => dependencies\.mix\.active/);
  assert.match(composition, /resetPlayerOffset: \(\) => dependencies\.offset\.reset\(\)/);
  assert.match(composition, /resetContentTimeline: \(\) => dependencies\.timeline\.reset\(\)/);
  assert.match(composition, /clearContentTransition: \(\) => mapping\.clearTransition\(\)/);
  assert.match(composition, /dropLegacyCalibrationForRobot: \(\) => legacyDrop\.drop\(\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ dependencies\.effects\.syncAppliedCalibration\(\); \}/);
  assert.match(composition, /reportSourceStatus: \(\) => dependencies\.effects\.reportSourceStatus\(\)/);
  assert.match(composition, /reportTimingStatus: \(\) => dependencies\.effects\.reportTimingStatus\(\)/);
  for (const canonical of ['take: takeController', 'mix: session', 'commands: { abandonProbeRun }',
    'offset: robotPlayerOffset', 'timeline: robotContentTimeline', 'calibration,']) assert.ok(binding.includes(canonical));
  assert.match(binding, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(binding, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});

test('Robot activation coordinator owns ordering only, not source or timing authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(
    coordinatorCode,
    /from '\.\/(?:source-runtime|take-controller|audio-session|calibration-session)\.js'/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /infrastructureCapability\.|sourceRuntime\.|takeController\.|robotPlayerOffset\.|robotContentTimeline\.|\bsendJson\b|\bbroadcastJson\b/,
  );
});
