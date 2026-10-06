import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-robot-lifecycle-protocol.ts', import.meta.url), 'utf8');
const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));
const activation = variableInitializerCode(mapping, 'activation');
const disconnect = variableInitializerCode(mapping, 'disconnect');
const binding = variableInitializerCode(parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server), 'relayRobotMapping');

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
  assert.match(binding, /type: 'robot-source-replaced'/);
  assert.match(activation, /noteQualityEvent: \(event\) => dependencies\.take\.noteQualityEvent\(event\)/);
  assert.match(activation, /dependencies\.commands\.abandonProbeRun\(\)/);
  assert.match(activation, /dependencies\.offset\.reset\(\)/);
  assert.match(activation, /dependencies\.timeline\.reset\(\)/);
  assert.match(activation, /mapping\.clearTransition\(\)/);
  assert.match(activation, /dropLegacyCalibrationForRobot: \(\) => legacyDrop\.drop\(\)/);
  assert.match(server, /dropLegacyCalibrationForRobot\(\)/);
  assert.match(binding, /syncAppliedCalibration\(\)/);
  assert.match(binding, /broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(binding, /broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  for (const canonical of ['take: takeController', 'offset: robotPlayerOffset', 'timeline: robotContentTimeline',
    'commands: { abandonProbeRun }', 'source: sourceRuntime']) assert.ok(binding.includes(canonical));

  assert.doesNotMatch(
    protocol,
    /InfrastructureCapabilityRuntime|SourceRuntime|TakeController|infrastructureCapability\.|sourceRuntime\.|takeController\.|robotPlayerOffset\.|robotContentTimeline\.|dropLegacyCalibrationForRobot|syncAppliedCalibration|sendJson|broadcastJson|performance\.now/,
  );
});

test('socket close routes Robot detach outside the message lifecycle protocol', () => {
  assert.match(disconnect, /^createRelayRobotDisconnectCoordinator<TSocket>/);
  assert.match(server, /if \(!socket\.replaced\) \{[\s\S]*relayRobotMapping\.disconnectSource\(socket\)/);
  assert.match(disconnect, /detach: \(socket\) => dependencies\.source\.detachRobot\(socket\)/);
  assert.match(binding, /source: sourceRuntime/);
  assert.doesNotMatch(protocol, /disconnect|detachRobot|socket\.on\('close'/);
});
