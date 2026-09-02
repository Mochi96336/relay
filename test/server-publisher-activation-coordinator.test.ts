import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-publisher-activation-coordinator.ts', import.meta.url),
  'utf8',
);

function publisherRegistrationBlock() {
  const registration = server.indexOf('const registrationProtocol = createRelayRegistrationProtocol<RelaySocket>({');
  const start = server.indexOf('publisher: (socket, payload) => {', registration);
  const end = server.indexOf('backing: (socket, payload) => {', start);
  assert.ok(registration >= 0 && start > registration && end > start);
  return server.slice(start, end);
}

test('publisher registration keeps admission, validation, ownership CAS and role commit in server', () => {
  const publisher = publisherRegistrationBlock();
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
  assert.match(
    server,
    /import \{ createRelayPublisherActivationCoordinator \} from '\.\/relay-publisher-activation-coordinator\.js';/,
  );
  assert.match(server, /const publisherActivationCoordinator = createRelayPublisherActivationCoordinator/);
  assert.match(server, /applyMicOwnerEffects\(effects, performance\.now\(\), \{/);
  assert.match(server, /bindPublisher: \(registration\) => micRuntime\.bindPublisher\(registration\)/);
  assert.match(server, /retirePublisherTransport\(/);
  assert.match(server, /micTransportGrace\.cancel\(\)/);
  assert.match(server, /session\.setMicExpected\(true\)/);
  assert.match(server, /takeController\.noteQualityEvent\('mic-transport-connected'\)/);
  assert.match(server, /invalidateMicTiming\(reason\)/);
  assert.match(server, /restartLiveSourceAfterMicReconnect\(\)/);
  assert.match(server, /micRuntime\.directMediaOffer\(\)/);
  assert.match(server, /sendJson\(socket, mixSettingsPayload\(\)\)/);
  assert.match(server, /sendJson\(socket, timingCalibrationStatusPayload\(\)\)/);
  assert.match(server, /broadcastSessionStatus\(\)/);
  assert.match(server, /beginPreparedSongHandoff\(participantId\)/);
});

test('activation coordinator owns ordering only, not Relay runtimes or participant authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:participant-session|mic-runtime|audio-session|take-controller|song-session|mic-owner-transition-application)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /participants\.|micRuntime\.|session\.|takeController\.|youtubeTimeline\.|micTransportGrace\.|\bsendJson\b|\bbroadcastJson\b|\bapplyMicOwnerEffects\b|\bretirePublisherTransport\b|\binvalidateMicTiming\b/,
  );
});
