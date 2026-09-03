import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-mic-capture-restart-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-mic-capture-restart-coordinator.ts', import.meta.url), 'utf8'),
);

test('server keeps Mic generation authority and delegates only confirmed restart effects', () => {
  const block = functionCode(server, 'processPublisherFrame');
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
  assert.ok(importSources(server).includes('./relay-mic-capture-restart-coordinator.js'));
  const composition = variableInitializerCode(server, 'micCaptureRestartCoordinator');
  assert.match(composition, /^createRelayMicCaptureRestartCoordinator\(\{/);
  assert.match(composition, /noteQualityEvent: \(event\) => takeController\.noteQualityEvent\(event\)/);
  assert.match(composition, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(composition, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(composition, /failCalibration: \(message\) => calibration\.fail\(message\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ syncAppliedCalibration\(\); \}/);
  assert.match(
    composition,
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/,
  );
  assert.match(composition, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
});

test('Mic capture restart coordinator owns ordering only, not runtime authority', () => {
  const coordinatorCode = sourceCode(coordinator);
  assert.doesNotMatch(coordinatorCode, /^import /m);
  assert.doesNotMatch(
    coordinatorCode,
    /\bsession\.|\btakeController\.|\bbootProbeRuntime\.|\bcontentCalibrationValidator\.|\btimingRuntime\.|\bbroadcastJson\b/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /(?:^|[^A-Za-z0-9_.])calibration\.(?:collecting|fail|reset|apply|begin|status|observe)/m,
  );
});
