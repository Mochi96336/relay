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
  new URL('../src/relay-registration-protocol.ts', import.meta.url),
  readFileSync(new URL('../src/relay-registration-protocol.ts', import.meta.url), 'utf8'),
);

test('server delegates known registration role selection through its own seam', () => {
  const serverCode = sourceCode(server);
  const serverFlow = functionCode(server, 'startRelayServer');
  const wiring = variableInitializerCode(server, 'registrationProtocol');
  const factory = functionCode(protocol, 'createRelayRegistrationProtocol');

  assert.match(wiring, /^createRelayRegistrationProtocol<RelaySocket>/);
  assert.match(serverFlow, /registrationProtocol\.dispatch\(socket, payload\)/);
  assert.match(factory, /payload\.type !== 'register'/);
  assert.match(factory, /case 'publisher'/);
  assert.match(factory, /case 'backing'/);
  assert.match(factory, /case 'monitor'/);
  assert.doesNotMatch(serverCode, /payload\.type === 'register' && payload\.role === 'publisher'/);
  assert.doesNotMatch(serverCode, /payload\.type === 'register' && payload\.role === 'backing'/);
  assert.doesNotMatch(serverCode, /payload\.type === 'register' && payload\.role === 'monitor'/);
});

test('server still owns registration authority, validation, and effects', () => {
  const serverFlow = functionCode(server, 'startRelayServer');
  const factory = functionCode(protocol, 'createRelayRegistrationProtocol');

  assert.match(serverFlow, /canClaimSocketRole\(socket, 'publisher'\)/);
  assert.match(serverFlow, /legacyTestParticipantIdentityEnabled\(\)/);
  assert.match(serverFlow, /validSampleRate\(payload\.sampleRate\)/);
  assert.match(serverFlow, /validAudioPacketVersion\(payload\.audioPacketVersion\)/);
  assert.match(serverFlow, /participants\.takeoverMic\(/);
  assert.match(serverFlow, /participants\.acquireMic\(/);
  assert.match(serverFlow, /commitSocketRole\(socket, 'publisher'\)/);
  assert.match(serverFlow, /micRuntime\.bindPublisher\(/);
  assert.match(serverFlow, /retirePublisherTransport\(/);

  assert.match(serverFlow, /infrastructureCapability\.authorized\(socket\)/);
  assert.match(serverFlow, /canClaimSocketRole\(socket, 'backing'\)/);
  assert.match(serverFlow, /commitSocketRole\(socket, 'backing'\)/);
  assert.match(serverFlow, /backingRuntime\.bind\(/);

  assert.match(serverFlow, /canClaimSocketRole\(socket, 'monitor'\)/);
  assert.match(serverFlow, /requestedMonitorPacketVersion/);
  assert.match(serverFlow, /commitSocketRole\(socket, 'monitor'\)/);
  assert.match(serverFlow, /socket\.monitorPacketVersion = monitorPacketVersion/);
  assert.match(serverFlow, /type: 'registered'/);

  assert.doesNotMatch(
    factory,
    /ParticipantSession|MicRuntime|BackingRuntime|infrastructureCapability|canClaimSocketRole|commitSocketRole|validSampleRate|validAudioPacketVersion|participants\.|micRuntime\.|backingRuntime\.|sendJson|performance\.now/,
  );
});

test('Robot lifecycle is not registration authority', () => {
  const serverFlow = functionCode(server, 'startRelayServer');
  const factory = functionCode(protocol, 'createRelayRegistrationProtocol');

  assert.match(serverFlow, /robotLifecycleProtocol\.dispatch\(socket, payload\)/);
  assert.doesNotMatch(factory, /robot-source-hello/);
});
