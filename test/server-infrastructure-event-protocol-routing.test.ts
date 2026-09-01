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
  assert.doesNotMatch(server, /payload\.type === 'backing-sample-boundary'/);
  assert.doesNotMatch(server, /payload\.type === 'robot-player-offset'/);
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

  assert.doesNotMatch(
    protocol,
    /BackingRuntime|SourceRuntime|RobotPlayerOffsetTracker|RobotContentTimelineMapper|RobotContentTransitionRuntime|performance\.now|session\./,
  );
});

test('authentication, registration, seek, and Robot lifecycle authority remain inline', () => {
  assert.match(server, /payload\.type === 'infrastructure-authenticate'/);
  assert.match(server, /payload\.type === 'participant-authenticate'/);
  assert.match(server, /payload\.type === 'register'/);
  assert.match(server, /payload\.type === 'source-seeked'/);
  assert.match(server, /payload\.type === 'robot-source-hello'/);
});
