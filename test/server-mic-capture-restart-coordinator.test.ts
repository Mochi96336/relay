import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-mic-capture-restart-coordinator.ts', import.meta.url),
  'utf8',
);

function publisherFrameBlock() {
  const start = server.indexOf('function processPublisherFrame(frame: PcmFrame) {');
  const end = server.indexOf('\n}\n\nfunction deliverMicPackets', start);
  assert.ok(start >= 0 && end > start);
  return server.slice(start, end + 2);
}

test('server keeps Mic generation authority and delegates only confirmed restart effects', () => {
  const block = publisherFrameBlock();
  assert.match(block, /const previousGeneration = session\.micGeneration;/);
  assert.match(block, /session\.ingestMic\(frame, micRuntime\.sampleRate\)/);
  assert.match(
    block,
    /const micRestarted = previousGeneration !== null && session\.micGeneration !== previousGeneration;/,
  );
  assert.match(
    block,
    /micCaptureRestartCoordinator\.restart\(\{\s*calibrationCollecting: calibration\.collecting,\s*\}\);/,
  );

  const restartStart = block.indexOf('if (micRestarted) {');
  const restartEnd = block.indexOf('\n      }', restartStart);
  assert.ok(restartStart >= 0 && restartEnd > restartStart);
  const restartBlock = block.slice(restartStart, restartEnd + '\n      }'.length);
  assert.doesNotMatch(restartBlock, /takeController\.|bootProbeRuntime\.|contentCalibrationValidator\./);
  assert.doesNotMatch(restartBlock, /calibration\.(?:fail|reset|apply|begin)/);
  assert.doesNotMatch(restartBlock, /broadcastJson\(|(?:^|[^.])syncAppliedCalibration\(/m);
});

test('server composition retains all Mic capture restart domain effects', () => {
  assert.match(
    server,
    /import \{ createRelayMicCaptureRestartCoordinator \} from '\.\/relay-mic-capture-restart-coordinator\.js';/,
  );
  assert.match(
    server,
    /const micCaptureRestartCoordinator = createRelayMicCaptureRestartCoordinator\(\{/,
  );
  assert.match(server, /noteQualityEvent: \(event\) => takeController\.noteQualityEvent\(event\)/);
  assert.match(server, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(server, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(server, /failCalibration: \(message\) => calibration\.fail\(message\)/);
  assert.match(server, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(
    server,
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/,
  );
  assert.match(server, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
});

test('Mic capture restart coordinator owns ordering only, not runtime authority', () => {
  assert.doesNotMatch(coordinator, /^import /m);
  assert.doesNotMatch(
    coordinator,
    /\bsession\.|\btakeController\.|\bbootProbeRuntime\.|\bcontentCalibrationValidator\.|\btimingRuntime\.|\bbroadcastJson\b/,
  );
  assert.doesNotMatch(
    coordinator,
    /(?:^|[^A-Za-z0-9_.])calibration\.(?:collecting|fail|reset|apply|begin|status|observe)/m,
  );
});
