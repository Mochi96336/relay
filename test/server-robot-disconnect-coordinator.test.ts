import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
const coordinator = fs.readFileSync(
  path.join(root, 'src/relay-robot-disconnect-coordinator.ts'),
  'utf8',
);

function closeBlock() {
  const start = server.indexOf("socket.on('close', () => {");
  const end = server.indexOf('const presenceChanged =', start);
  assert.ok(start >= 0 && end > start, 'socket close block must remain identifiable');
  return server.slice(start, end);
}

test('server composes Robot disconnect coordinator from existing authority/effects', () => {
  assert.match(
    server,
    /import \{ createRelayRobotDisconnectCoordinator \} from '\.\/relay-robot-disconnect-coordinator\.js';/,
  );
  assert.match(server, /const robotDisconnectCoordinator = createRelayRobotDisconnectCoordinator<RelaySocket>\(\{/);
  assert.match(server, /isActive: \(socket\) => sourceRuntime\.isActive\(socket\)/);
  assert.match(server, /noteDisconnected: \(\) => takeController\.noteQualityEvent\('robot-source-disconnected'\)/);
  assert.match(server, /detach: \(socket\) => sourceRuntime\.detachRobot\(socket\)/);
  assert.match(server, /resetPlayerOffset: \(\) => robotPlayerOffset\.reset\(\)/);
  assert.match(server, /resetContentTimeline: \(\) => robotContentTimeline\.reset\(\)/);
  assert.match(server, /clearBackingBoundaryRequest: \(\) => clearRobotBackingBoundaryRequest\(\)/);
  assert.match(server, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(server, /syncAppliedCalibration: \(\) => syncAppliedCalibration\(\)/);
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(server, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});

test('close callback keeps replacement fence and Robot, Mic, Backing dispatch order', () => {
  const close = closeBlock();
  const fence = close.indexOf('if (!socket.replaced) {');
  const robot = close.indexOf('robotDisconnectCoordinator.handle(socket);');
  const mic = close.indexOf('micDisconnectCoordinator.handle(socket);');
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
