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
const pump = parseTypeScriptSource(
  new URL('../src/relay-mix-pump.ts', import.meta.url),
  readFileSync(new URL('../src/relay-mix-pump.ts', import.meta.url), 'utf8'),
);
const lifecycle = parseTypeScriptSource(
  new URL('../src/relay-mic-lifecycle.ts', import.meta.url),
  readFileSync(new URL('../src/relay-mic-lifecycle.ts', import.meta.url), 'utf8'),
);

test('server delegates AudioSession capture-clock restarts before consuming new Mic PCM', () => {
  const block = functionCode(pump, 'ingest');
  assert.doesNotMatch(block, /previousGeneration|micRestarted/);
  assert.match(block, /const nowMs = dependencies\.now\(\);/);
  assert.match(
    block,
    /const \{ samples, start, captureRestarted \} = dependencies\.mix\.ingestMic\(\s*frame,\s*dependencies\.mic\.sampleRate,\s*nowMs,\s*\);/,
  );
  assert.match(block, /if \(samples\.length > 0\) dependencies\.mic\.noteFrame\(nowMs, frame\);/);
  assert.match(
    block,
    /dependencies\.restart\.restart\(\{\s*calibrationCollecting: dependencies\.calibration\.collecting\s*\}\);/,
  );

  const restartStart = block.indexOf('if (captureRestarted) {');
  const restartEnd = block.indexOf('\n    }', restartStart);
  assert.ok(restartStart >= 0 && restartEnd > restartStart);
  const restartBlock = block.slice(restartStart, restartEnd + '\n    }'.length);
  assert.doesNotMatch(restartBlock, /dependencies\.(?:take|validator|transition)\./);
  assert.doesNotMatch(restartBlock, /dependencies\.calibration\.(?:fail|reset|apply|begin)/);
  assert.doesNotMatch(restartBlock, /broadcastJson\(|(?:^|[^.])syncAppliedCalibration\(/m);

  const ingest = block.indexOf('dependencies.mix.ingestMic(');
  const noteFlow = block.indexOf('if (samples.length > 0) dependencies.mic.noteFrame(nowMs, frame);');
  const restart = block.indexOf('dependencies.restart.restart({');
  assert.ok(ingest >= 0 && noteFlow > ingest, 'flow freshness must require accepted PCM progress');
  assert.ok(restart > noteFlow, 'capture restart effects must follow ingest and flow classification');

  for (const consumer of [
    'dependencies.calibration.primeMic(samples, start)',
    'dependencies.calibration.observeMic(samples, start)',
    'dependencies.validator.observeMic(samples, start)',
    'dependencies.transition.noteMicProgress()',
  ]) {
    const consumerIndex = block.indexOf(consumer);
    assert.ok(
      consumerIndex > restart,
      `${consumer} must not observe replacement-capture PCM before restart effects settle`,
    );
  }
  const binding = variableInitializerCode(server, 'relayMixPump');
  assert.match(binding, /mix: session/);
  assert.match(binding, /mic: micRuntime/);
  assert.match(binding, /restart: \{ restart: relayMicLifecycle\.restartCapture \}/);
  assert.match(binding, /calibration,/);
  assert.match(binding, /validator: contentCalibrationValidator/);
  assert.match(binding, /transition: robotContentTransitionRuntime/);
  assert.match(binding, /now: \(\) => performance\.now\(\)/);
});

test('server composition retains all Mic capture restart domain effects', () => {
  assert.ok(importSources(lifecycle).includes('./relay-mic-capture-restart-coordinator.js'));
  assert.ok(importSources(server).includes('./relay-mic-lifecycle.js'));
  assert.equal(importSources(server).includes('./relay-mic-capture-restart-coordinator.js'), false);
  const composition = functionCode(lifecycle, 'createRelayMicCaptureRestartLifecycle');
  assert.match(composition, /const coordinator = createRelayMicCaptureRestartCoordinator\(\{/);
  assert.match(composition, /noteQualityEvent: \(event\) => dependencies\.take\.noteQualityEvent\(event\)/);
  assert.match(composition, /abandonProbeRun: \(\) => dependencies\.commands\.abandonProbeRun\(\)/);
  assert.match(composition, /clearContentValidation: \(\) => dependencies\.commands\.clearContentValidationBaseline\(\)/);
  assert.match(composition, /failCalibration: \(message\) => dependencies\.calibration\.fail\(message\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => \{ dependencies\.commands\.syncAppliedCalibration\(\); \}/);
  assert.match(
    composition,
    /reportTimingStatus: \(\) => dependencies\.effects\.reportTimingStatus\(\)/,
  );
  assert.match(composition, /reportSourceStatus: \(\) => dependencies\.effects\.reportSourceStatus\(\)/);
  const root = variableInitializerCode(server, 'relayMicLifecycle');
  assert.match(root, /take: takeController/);
  assert.match(root, /calibration,/);
  for (const command of ['abandonProbeRun,', 'clearContentValidationBaseline,', 'syncAppliedCalibration,']) {
    assert.ok(root.includes(command));
  }
  assert.match(root, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(root, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
  assert.match(functionCode(lifecycle, 'createRelayMicLifecycle'), /restartCapture: captureRestart\.restartCapture/);
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
