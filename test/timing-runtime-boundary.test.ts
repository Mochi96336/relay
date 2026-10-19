import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const runtime = parseTypeScriptSource(
  new URL('../src/timing-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/timing-runtime.ts', import.meta.url), 'utf8'),
);
const contentCoordinator = parseTypeScriptSource(
  new URL('../src/content-calibration-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/content-calibration-coordinator.ts', import.meta.url), 'utf8'),
);
const serverCode = sourceCode(server);

test('TimingRuntime owns orchestration metadata without absorbing timing authorities', () => {
  const construction = variableInitializerCode(server, 'timingRuntime');
  assert.ok(construction.includes('new TimingRuntime({'));
  assert.ok(construction.includes('autoCalibrationRetryMs: AUTO_CALIBRATION_RETRY_MS'));
  assert.doesNotMatch(
    serverCode,
    /let\s+(?:lastAutoCalibrationAt|calibrationWasAutomatic|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/,
  );

  assert.ok(variableInitializerCode(server, 'contentCalibration').includes('new ContentCalibrationCoordinator({'));
  assert.equal(variableInitializerCode(server, 'calibration'), 'contentCalibration.measurement');
  assert.equal(variableInitializerCode(server, 'contentCalibrationValidator'), 'contentCalibration.validation');
  assert.ok(variableInitializerCode(server, 'bootProbe').includes('new BootProbeCoordinator({'));

  const imports = importSources(runtime);
  for (const forbidden of [
    './calibration-session.js',
    './content-calibration-validator.js',
    './probe-lifecycle.js',
    './audio-session.js',
    './take-controller.js',
    './robot-player-offset.js',
    './robot-content-timeline.js',
  ]) {
    assert.equal(imports.includes(forbidden), false, 'TimingRuntime must not absorb authority from ' + forbidden);
  }
});

test('server projects automatic provenance from TimingRuntime', () => {
  assert.ok(serverCode.includes('automatic: timingRuntime.automatic'));
});

test('content coordination owns measurement and validation without physical transports or storage', () => {
  const imports = importSources(contentCoordinator);
  assert.ok(imports.includes('./calibration-session.js'));
  assert.ok(imports.includes('./content-calibration-validator.js'));
  for (const forbidden of [
    'ws', 'node:fs', 'node:worker_threads', './audio-session.js',
    './source-runtime.js', './backing-runtime.js', './mic-runtime.js',
    './take-controller.js', './server.js',
  ]) {
    assert.equal(imports.includes(forbidden), false, `content coordination must not own ${forbidden}`);
  }
});
