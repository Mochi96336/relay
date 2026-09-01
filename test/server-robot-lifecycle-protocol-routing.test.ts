import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-robot-lifecycle-protocol.ts', import.meta.url), 'utf8');

test('server delegates Robot source hello selection through its own lifecycle seam', () => {
  assert.match(server, /createRelayRobotLifecycleProtocol<RelaySocket>/);
  assert.match(server, /robotLifecycleProtocol\.dispatch\(socket, payload\)/);
  assert.match(protocol, /payload\.type !== 'robot-source-hello'/);
  assert.doesNotMatch(server, /payload\.type === 'robot-source-hello'/);
});

test('server still owns Robot source lifecycle authority and effects', () => {
  assert.match(server, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(server, /rejectInfrastructure\(socket, 'Authenticate Relay infrastructure before becoming the Robot source\.'\)/);
  assert.match(server, /sourceRuntime\.isActive\(socket\)/);
  assert.match(server, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(server, /type: 'robot-source-replaced'/);
  assert.match(server, /takeController\.noteQualityEvent\('robot-source-replaced'\)/);
  assert.match(server, /takeController\.noteQualityEvent\('robot-source-connected'\)/);
  assert.match(server, /abandonProbeRun\(\)/);
  assert.match(server, /robotPlayerOffset\.reset\(\)/);
  assert.match(server, /robotContentTimeline\.reset\(\)/);
  assert.match(server, /clearRobotBackingBoundaryRequest\(\)/);
  assert.match(server, /dropLegacyCalibrationForRobot\(\)/);
  assert.match(server, /syncAppliedCalibration\(\)/);
  assert.match(server, /broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(server, /broadcastJson\(timingCalibrationStatusPayload\(\)\)/);

  assert.doesNotMatch(
    protocol,
    /InfrastructureCapabilityRuntime|SourceRuntime|TakeController|infrastructureCapability|sourceRuntime|takeController|robotPlayerOffset|robotContentTimeline|calibration|sendJson|broadcastJson|performance\.now/,
  );
});

test('socket close still owns Robot detach lifecycle rather than the message router', () => {
  assert.match(server, /if \(sourceRuntime\.isActive\(socket\)\) \{/);
  assert.match(server, /sourceRuntime\.detachRobot\(socket\)/);
  assert.doesNotMatch(protocol, /detachRobot|socket\.on\('close'/);
});
