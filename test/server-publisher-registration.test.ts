import assert from 'node:assert/strict';
import test from 'node:test';

import { objectArrowCallbackCode, readSourceContract } from './support/source-contract.js';

const server = readSourceContract('src/server.ts');

test('publisher registration keeps admission, validation, ownership CAS and role commit in server', () => {
  const publisher = objectArrowCallbackCode(server, 'registrationProtocol', 'publisher');
  assert.match(publisher, /canClaimSocketRole\(socket, 'publisher'\)/);
  assert.match(publisher, /if \(!socket\.participantId\) \{/);
  assert.match(publisher, /validSampleRate\(payload\.sampleRate\)/);
  assert.match(publisher, /validCaptureGeneration\(payload\.captureGeneration\)/);
  assert.match(publisher, /validAudioPacketVersion\(payload\.audioPacketVersion\)/);
  assert.match(publisher, /participants\.takeoverMic\(socket\.participantId, expectedOwnerId\)/);
  assert.match(publisher, /participants\.acquireMic\(socket\.participantId\)/);
  assert.match(publisher, /commitSocketRole\(socket, 'publisher'\)/);
  assert.match(publisher, /publisherActivated\(\{/);

  assert.doesNotMatch(publisher, /applyMicOwnerEffects\(/);
  assert.doesNotMatch(publisher, /micRuntime\.bindPublisher\(/);
  assert.doesNotMatch(publisher, /retirePublisherTransport\(/);
  assert.doesNotMatch(publisher, /micTransportGrace\.cancel\(\)/);
  assert.doesNotMatch(publisher, /restartLiveSourceAfterMicReconnect\(\)/);
});
