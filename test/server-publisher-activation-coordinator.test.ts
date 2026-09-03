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
  new URL('../src/relay-publisher-activation-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-publisher-activation-coordinator.ts', import.meta.url), 'utf8'),
);

test('publisher registration keeps admission, validation, ownership CAS and role commit in server', () => {
  const publisher = objectArrowCallbackCode(server, 'registrationProtocol', 'publisher');
  assert.match(publisher, /canClaimSocketRole\(socket, 'publisher'\)/);
  assert.match(publisher, /legacyTestParticipantIdentityEnabled\(\)/);
  assert.match(publisher, /validSampleRate\(payload\.sampleRate\)/);
  assert.match(publisher, /validCaptureGeneration\(payload\.captureGeneration\)/);
  assert.match(publisher, /validAudioPacketVersion\(payload\.audioPacketVersion\)/);
  assert.match(publisher, /participants\.takeoverMic\(socket\.participantId, expectedOwnerId\)/);
  assert.match(publisher, /participants\.acquireMic\(socket\.participantId\)/);
  assert.match(publisher, /commitSocketRole\(socket, 'publisher'\)/);
  assert.match(publisher, /publisherActivationCoordinator\.activate\(\{/);

  assert.doesNotMatch(publisher, /applyMicOwnerEffects\(/);
  assert.doesNotMatch(publisher, /micRuntime\.bindPublisher\(/);
  assert.doesNotMatch(publisher, /retirePublisherTransport\(/);
  assert.doesNotMatch(publisher, /micTransportGrace\.cancel\(\)/);
  assert.doesNotMatch(publisher, /restartLiveSourceAfterMicReconnect\(\)/);
});

test('server composition retains publisher activation domain effects', () => {
  assert.ok(importSources(server).includes('./relay-publisher-activation-coordinator.js'));
  const composition = variableInitializerCode(server, 'publisherActivationCoordinator');
  assert.match(composition, /^createRelayPublisherActivationCoordinator/);
  assert.match(composition, /applyMicOwnerEffects\(effects, performance\.now\(\), \{/);
  assert.match(composition, /bindPublisher: \(registration\) => micRuntime\.bindPublisher\(registration\)/);
  assert.match(composition, /retirePublisherTransport\(/);
  assert.match(composition, /micTransportGrace\.cancel\(\)/);
  assert.match(composition, /session\.setMicExpected\(true\)/);
  assert.match(composition, /takeController\.noteQualityEvent\('mic-transport-connected'\)/);
  assert.match(composition, /invalidateMicTiming\(reason\)/);
  assert.match(composition, /restartLiveSourceAfterMicReconnect\(\)/);
  assert.match(composition, /micRuntime\.directMediaOffer\(\)/);
  assert.match(composition, /sendJson\(socket, mixSettingsPayload\(\)\)/);
  assert.match(composition, /sendJson\(socket, timingCalibrationStatusPayload\(\)\)/);
  assert.match(composition, /broadcastSessionStatus\(\)/);
  assert.match(composition, /beginPreparedSongHandoff\(participantId\)/);
});

test('activation coordinator owns ordering only, not Relay runtimes or participant authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(
    coordinatorCode,
    /from '\.\/(?:participant-session|mic-runtime|audio-session|take-controller|song-session|mic-owner-transition-application)\.js'/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /participants\.|micRuntime\.|session\.|takeController\.|youtubeTimeline\.|micTransportGrace\.|\bsendJson\b|\bbroadcastJson\b|\bapplyMicOwnerEffects\b|\bretirePublisherTransport\b|\binvalidateMicTiming\b/,
  );
});
