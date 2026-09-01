import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-infrastructure-event-protocol.ts', import.meta.url), 'utf8');

test('server delegates low-risk infrastructure observations through their own routing seam', () => {
  assert.match(server, /createRelayInfrastructureEventProtocol<RelaySocket>/);
  assert.match(server, /infrastructureEventProtocol\.dispatch\(socket, payload\)/);
  assert.match(protocol, /case 'backing-sample-boundary'/);
  assert.match(protocol, /case 'robot-player-offset'/);
  assert.match(protocol, /case 'calibration-probe-played'/);
  assert.match(protocol, /case 'calibration-probe-failed'/);
  assert.match(protocol, /case 'source-seeked'/);
  assert.doesNotMatch(server, /payload\.type === 'backing-sample-boundary'/);
  assert.doesNotMatch(server, /payload\.type === 'robot-player-offset'/);
  assert.doesNotMatch(server, /payload\.type === 'calibration-probe-played' \|\| payload\.type === 'calibration-probe-failed'/);
  assert.doesNotMatch(server, /payload\.type === 'source-seeked'/);
});

test('server still owns infrastructure observation authority and effects', () => {
  assert.match(server, /backingRuntime\.isSocket\(socket\)/);
  assert.match(server, /socket\.role !== 'backing'/);
  assert.match(server, /!backingRuntime\.isRobot/);
  assert.match(server, /validCaptureGeneration\(payload\.generation\)/);
  assert.match(server, /robotContentTransitionRuntime\.acceptBackingBoundary\(/);
  assert.match(server, /currentBackingGeneration: session\.backingGeneration/);
  assert.match(server, /context: calibrationContext\(\)/);

  assert.match(server, /sourceRuntime\.isActiveRobot\(socket\)/);
  assert.match(server, /Number\.isFinite\(offsetMs\)/);
  assert.match(server, /robotPlayerOffset\.record\(offsetMs, nowMs\)/);
  assert.match(server, /robotContentTimeline\.notePlayerOffset\(/);
  assert.match(server, /if \(mapped\) requestRobotBackingBoundary\(nowMs\)/);

  assert.match(server, /micRuntime\.isPublisher\(socket\)/);
  assert.match(server, /payload\.target === 'backing' \? 'backing' : 'mic'/);
  assert.match(server, /handleProbeReply\(\{ requestId: payload\.requestId, generation: payload\.generation \}, nowMs\)/);
  assert.match(server, /handleProbeFailure\(/);

  assert.match(server, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(server, /sourceRuntime\.canReportSeek\(socket\)/);
  assert.match(server, /robotContentTransitionRuntime\.clearPendingBoundary\(\)/);
  assert.match(server, /robotContentTimeline\.noteFollowerCorrection\(/);
  assert.match(server, /beginRobotContentTransition\(/);
  assert.match(server, /sourceRuntime\.invalidateMapping\(\)/);
  assert.match(server, /calibration\.discardPrimedContent\(\)/);

  assert.doesNotMatch(
    protocol,
    /BackingRuntime|SourceRuntime|MicRuntime|RobotPlayerOffsetTracker|RobotContentTimelineMapper|RobotContentTransitionRuntime|handleProbeReply|handleProbeFailure|performance\.now|session\.|infrastructureCapability/,
  );
});

test('authentication, registration, and Robot lifecycle authority remain inline', () => {
  assert.match(server, /payload\.type === 'infrastructure-authenticate'/);
  assert.match(server, /payload\.type === 'participant-authenticate'/);
  assert.match(server, /payload\.type === 'register'/);
  assert.match(server, /payload\.type === 'robot-source-hello'/);
});
