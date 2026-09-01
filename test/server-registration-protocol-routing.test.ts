import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-registration-protocol.ts', import.meta.url), 'utf8');

test('server delegates known registration role selection through its own seam', () => {
  assert.match(server, /createRelayRegistrationProtocol<RelaySocket>/);
  assert.match(server, /registrationProtocol\.dispatch\(socket, payload\)/);
  assert.match(protocol, /payload\.type !== 'register'/);
  assert.match(protocol, /case 'publisher'/);
  assert.match(protocol, /case 'backing'/);
  assert.match(protocol, /case 'monitor'/);
  assert.doesNotMatch(server, /payload\.type === 'register' && payload\.role === 'publisher'/);
  assert.doesNotMatch(server, /payload\.type === 'register' && payload\.role === 'backing'/);
  assert.doesNotMatch(server, /payload\.type === 'register' && payload\.role === 'monitor'/);
});

test('server still owns registration authority, validation, and effects', () => {
  assert.match(server, /canClaimSocketRole\(socket, 'publisher'\)/);
  assert.match(server, /legacyTestParticipantIdentityEnabled\(\)/);
  assert.match(server, /validSampleRate\(payload\.sampleRate\)/);
  assert.match(server, /validAudioPacketVersion\(payload\.audioPacketVersion\)/);
  assert.match(server, /participants\.takeoverMic\(/);
  assert.match(server, /participants\.acquireMic\(/);
  assert.match(server, /commitSocketRole\(socket, 'publisher'\)/);
  assert.match(server, /micRuntime\.bindPublisher\(/);
  assert.match(server, /retirePublisherTransport\(/);

  assert.match(server, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(server, /canClaimSocketRole\(socket, 'backing'\)/);
  assert.match(server, /commitSocketRole\(socket, 'backing'\)/);
  assert.match(server, /backingRuntime\.bind\(/);

  assert.match(server, /canClaimSocketRole\(socket, 'monitor'\)/);
  assert.match(server, /requestedMonitorPacketVersion/);
  assert.match(server, /commitSocketRole\(socket, 'monitor'\)/);
  assert.match(server, /socket\.monitorPacketVersion = monitorPacketVersion/);
  assert.match(server, /type: 'registered'/);

  assert.doesNotMatch(
    protocol,
    /ParticipantSession|MicRuntime|BackingRuntime|infrastructureCapability|canClaimSocketRole|commitSocketRole|validSampleRate|validAudioPacketVersion|participants\.|micRuntime\.|backingRuntime\.|sendJson|performance\.now/,
  );
});

test('Robot lifecycle is not registration authority', () => {
  assert.match(server, /robotLifecycleProtocol\.dispatch\(socket, payload\)/);
  assert.doesNotMatch(protocol, /robot-source-hello/);
});
