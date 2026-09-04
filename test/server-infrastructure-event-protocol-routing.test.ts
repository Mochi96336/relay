import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const protocol = parseTypeScriptSource(
  new URL('../src/relay-infrastructure-event-protocol.ts', import.meta.url),
  readFileSync(new URL('../src/relay-infrastructure-event-protocol.ts', import.meta.url), 'utf8'),
);

test('server delegates low-risk infrastructure observations through their own routing seam', () => {
  const serverCode = sourceCode(server);
  const serverFlow = functionCode(server, 'startRelayServer');
  const wiring = variableInitializerCode(server, 'infrastructureEventProtocol');
  const factory = functionCode(protocol, 'createRelayInfrastructureEventProtocol');

  assert.match(wiring, /^createRelayInfrastructureEventProtocol<RelaySocket>/);
  assert.match(serverFlow, /infrastructureEventProtocol\.dispatch\(socket, payload\)/);
  assert.match(factory, /case 'backing-sample-boundary'/);
  assert.match(factory, /case 'robot-player-offset'/);
  assert.match(factory, /case 'calibration-probe-played'/);
  assert.match(factory, /case 'calibration-probe-failed'/);
  assert.match(factory, /case 'source-seeked'/);
  assert.doesNotMatch(serverCode, /payload\.type === 'backing-sample-boundary'/);
  assert.doesNotMatch(serverCode, /payload\.type === 'robot-player-offset'/);
  assert.doesNotMatch(serverCode, /payload\.type === 'calibration-probe-played' \|\| payload\.type === 'calibration-probe-failed'/);
  assert.doesNotMatch(serverCode, /payload\.type === 'source-seeked'/);
});

test('server still owns infrastructure observation authority and effects', () => {
  const serverFlow = functionCode(server, 'startRelayServer');
  const factory = functionCode(protocol, 'createRelayInfrastructureEventProtocol');

  assert.match(serverFlow, /backingRuntime\.isSocket\(socket\)/);
  assert.match(serverFlow, /socket\.role !== 'backing'/);
  assert.match(serverFlow, /!backingRuntime\.isRobot/);
  assert.match(serverFlow, /validCaptureGeneration\(payload\.generation\)/);
  assert.match(serverFlow, /robotContentTransitionRuntime\.acceptBackingBoundary\(/);
  assert.match(serverFlow, /currentBackingGeneration: session\.backingGeneration/);
  assert.match(serverFlow, /context: calibrationContext\(\)/);

  assert.match(serverFlow, /sourceRuntime\.isActiveRobot\(socket\)/);
  assert.match(serverFlow, /Number\.isFinite\(offsetMs\)/);
  assert.match(serverFlow, /robotPlayerOffset\.record\(offsetMs, nowMs\)/);
  assert.match(serverFlow, /robotContentTimeline\.notePlayerOffset\(/);
  assert.match(serverFlow, /if \(mapped\) requestRobotBackingBoundary\(nowMs\)/);

  assert.match(serverFlow, /micRuntime\.isPublisher\(socket\)/);
  assert.match(serverFlow, /payload\.target === 'backing' \? 'backing' : 'mic'/);
  assert.match(serverFlow, /handleProbeReply\(\{ requestId: payload\.requestId, generation: payload\.generation \}, nowMs\)/);
  assert.match(serverFlow, /handleProbeFailure\(/);

  assert.match(serverFlow, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(serverFlow, /sourceRuntime\.canReportSeek\(socket\)/);
  assert.match(serverFlow, /robotContentTransitionRuntime\.clearPendingBoundary\(\)/);
  assert.match(serverFlow, /robotContentTimeline\.noteFollowerCorrection\(/);
  assert.match(serverFlow, /sourceSeekTransactionCoordinator\.handle\(\{/);
  assert.match(serverFlow, /beginContentTransition: \(fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs\) => \{/);
  assert.match(serverFlow, /beginRobotContentTransition\(/);
  // The destructive branch's teardown is the server's one revocation
  // transaction, so the composition supplies that rather than each step.
  assert.match(serverFlow, /revokeContentMapping: \(reason\) => revokeRobotContentMapping\(\{ reason \}\)/);

  assert.doesNotMatch(
    factory,
    /BackingRuntime|SourceRuntime|MicRuntime|RobotPlayerOffsetTracker|RobotContentTimelineMapper|RobotContentTransitionRuntime|handleProbeReply|handleProbeFailure|performance\.now|session\.|infrastructureCapability/,
  );
});

test('Robot lifecycle is not an infrastructure observation', () => {
  const serverFlow = functionCode(server, 'startRelayServer');
  const factory = functionCode(protocol, 'createRelayInfrastructureEventProtocol');

  assert.match(serverFlow, /robotLifecycleProtocol\.dispatch\(socket, payload\)/);
  assert.doesNotMatch(factory, /robot-source-hello/);
});
