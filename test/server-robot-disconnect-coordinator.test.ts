import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
const coordinator = fs.readFileSync(
  path.join(root, 'src/relay-robot-disconnect-coordinator.ts'),
  'utf8',
);
const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  fs.readFileSync(path.join(root, 'src/relay-robot-mapping-orchestration.ts'), 'utf8'));
const composition = variableInitializerCode(mapping, 'disconnect');
const binding = variableInitializerCode(parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server), 'relayRobotMapping');

function closeBlock() {
  const start = server.indexOf("socket.on('close', () => {");
  const end = server.indexOf('const presenceChanged =', start);
  assert.ok(start >= 0 && end > start, 'socket close block must remain identifiable');
  return server.slice(start, end);
}

test('server composes Robot disconnect coordinator from existing authority/effects', () => {
  assert.match(
    mapping.text,
    /import \{ createRelayRobotDisconnectCoordinator \} from '\.\/relay-robot-disconnect-coordinator\.js';/,
  );
  assert.match(composition, /^createRelayRobotDisconnectCoordinator<TSocket>\(\{/);
  assert.match(composition, /isActive: \(socket\) => dependencies\.source\.isActive\(socket\)/);
  assert.match(composition, /noteDisconnected: \(\) => dependencies\.take\.noteQualityEvent\('robot-source-disconnected'\)/);
  assert.match(composition, /detach: \(socket\) => dependencies\.source\.detachRobot\(socket\)/);
  assert.match(composition, /resetPlayerOffset: \(\) => dependencies\.offset\.reset\(\)/);
  assert.match(composition, /resetContentTimeline: \(\) => dependencies\.timeline\.reset\(\)/);
  assert.match(composition, /clearContentTransition: \(\) => mapping\.clearTransition\(\)/);
  assert.match(composition, /abandonProbeRun: \(\) => dependencies\.commands\.abandonProbeRun\(\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => dependencies\.effects\.syncAppliedCalibration\(\)/);
  assert.match(composition, /reportSourceStatus: \(\) => dependencies\.effects\.reportSourceStatus\(\)/);
  assert.match(composition, /reportTimingStatus: \(\) => dependencies\.effects\.reportTimingStatus\(\)/);
  for (const canonical of ['source: sourceRuntime', 'take: takeController', 'offset: robotPlayerOffset',
    'timeline: robotContentTimeline', 'commands: { abandonProbeRun }', 'calibration,']) assert.ok(binding.includes(canonical));
  assert.match(binding, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(binding, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});

test('close callback keeps replacement fence and Robot, Mic, Backing dispatch order', () => {
  const close = closeBlock();
  const fence = close.indexOf('if (!socket.replaced) {');
  const robot = close.indexOf('relayRobotMapping.disconnectSource(socket);');
  const mic = close.indexOf('relayMicLifecycle.disconnect(socket);');
  const backing = close.indexOf('backingDisconnectCoordinator.handle(socket);');

  assert.ok(fence >= 0 && robot > fence, 'replacement fence must remain outside Robot disconnect seam');
  assert.ok(mic > robot, 'Mic disconnect dispatch must remain after Robot cleanup');
  assert.ok(backing > mic, 'Backing disconnect dispatch must remain after Mic cleanup');
  assert.doesNotMatch(close, /if \(sourceRuntime\.isActive\(socket\)\) \{/);
  assert.doesNotMatch(close, /if \(micRuntime\.isPublisher\(socket\)\) \{/);
  assert.doesNotMatch(close, /if \(backingRuntime\.isSocket\(socket\)\) \{/);
});

test('coordinator owns ordering only, not Robot/calibration domain state', () => {
  assert.doesNotMatch(
    coordinator,
    /SourceRuntime|RobotPlayerOffsetTracker|RobotContentTimelineMapper|CalibrationSession|TakeController|broadcastJson|sourceStatusPayload|timingCalibrationStatusPayload/,
  );
});
