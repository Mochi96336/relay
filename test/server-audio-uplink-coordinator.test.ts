import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-audio-uplink-coordinator.ts', import.meta.url),
  'utf8',
);

test('server delegates binary audio routing through the uplink coordinator seam', () => {
  assert.match(
    server,
    /import \{ createRelayAudioUplinkCoordinator \} from '\.\/relay-audio-uplink-coordinator\.js';/,
  );
  assert.match(server, /const audioUplinkCoordinator = createRelayAudioUplinkCoordinator<RelaySocket>\(\{/);
  assert.match(server, /audioUplinkCoordinator\.handle\(socket, data as Buffer\)/);

  const start = server.indexOf('if (isBinary) {');
  const end = server.indexOf('let message: unknown;', start);
  assert.ok(start >= 0 && end > start, 'binary message branch must remain identifiable');
  const binary = server.slice(start, end);
  assert.doesNotMatch(binary, /micRuntime\.receivePublisher/);
  assert.doesNotMatch(binary, /session\.ingestBacking/);
  assert.doesNotMatch(binary, /decodePcmFrame/);
});

test('server composition retains audio uplink authority and domain effects', () => {
  assert.match(server, /isMicPublisher: \(socket\) => micRuntime\.isPublisher\(socket\)/);
  assert.match(server, /deliverMicPackets\(micRuntime\.receivePublisher\(socket, data, nowMs\)\)/);
  assert.match(
    server,
    /backingRuntime\.isSocket\(socket\) && socket\.role === 'backing' && session\.active/,
  );
  assert.match(server, /decodeBacking: \(data\) => decodePcmFrame\(data\)/);
  assert.match(server, /backingGeneration: \(\) => session\.backingGeneration/);
  assert.match(server, /noteBackingFrame: \(socket, nowMs\) => backingRuntime\.noteFrame\(socket, nowMs\)/);
  assert.match(server, /session\.ingestBacking\(\s*frame,\s*backingRuntime\.sampleRate,\s*nowMs,\s*backingRuntime\.isRobot,?\s*\)/);

  const restartStart = server.indexOf('const backingCaptureRestartCoordinator =');
  const uplinkStart = server.indexOf('const audioUplinkCoordinator =', restartStart);
  assert.ok(
    restartStart >= 0 && uplinkStart > restartStart,
    'Backing restart composition must remain immediately upstream of audio uplink composition',
  );
  const restartComposition = server.slice(restartStart, uplinkStart);
  assert.match(restartComposition, /noteQualityEvent: \(event\) => takeController\.noteQualityEvent\(event\)/);
  assert.match(restartComposition, /failCalibration: \(message\) => calibration\.fail\(message\)/);

  const disconnectStart = server.indexOf('const robotDisconnectCoordinator =', uplinkStart);
  assert.ok(disconnectStart > uplinkStart, 'audio uplink composition must remain identifiable');
  const uplinkComposition = server.slice(uplinkStart, disconnectStart);
  assert.match(
    uplinkComposition,
    /onBackingCaptureRestarted: \(\) => \{\s*backingCaptureRestartCoordinator\.restart\(\{\s*calibrationCollecting: calibration\.collecting,\s*\}\);\s*\}/,
  );

  assert.match(server, /noteRobotTransitionBackingFrame\(frame, samples, start, nowMs\)/);
  assert.match(server, /mappedContentBackingStart\(start, nowMs\)/);
  assert.match(server, /feedContentBackingEvidence\(samples, start, nowMs\)/);
});

test('uplink coordinator imports only the PCM frame type and owns no server runtimes', () => {
  assert.match(coordinator, /import type \{ PcmFrame \} from '\.\/pcm-frame\.js';/);
  assert.doesNotMatch(coordinator, /from '\.\/(?:mic-runtime|backing-runtime|audio-session|calibration-session|take-controller)\.js'/);
  assert.doesNotMatch(
    coordinator,
    /micRuntime|backingRuntime|session\.ingestBacking|takeController|calibration\.(?:collecting|fail)|broadcastJson|broadcastStatus|clearRobotBackingBoundaryRequest|abandonProbeRun|clearContentValidationBaseline|syncAppliedCalibration/,
  );
});
