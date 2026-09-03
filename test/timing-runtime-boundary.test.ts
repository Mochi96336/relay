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
const serverCode = sourceCode(server);

test('TimingRuntime owns orchestration metadata without absorbing timing authorities', () => {
  const construction = variableInitializerCode(server, 'timingRuntime');
  assert.ok(construction.includes('new TimingRuntime({'));
  assert.ok(construction.includes('autoCalibrationRetryMs: AUTO_CALIBRATION_RETRY_MS'));
  assert.doesNotMatch(
    serverCode,
    /let\s+(?:lastAutoCalibrationAt|calibrationWasAutomatic|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/,
  );

  assert.ok(variableInitializerCode(server, 'calibration').includes('new CalibrationSession({'));
  assert.ok(variableInitializerCode(server, 'contentCalibrationValidator').includes('new ContentCalibrationValidator({'));
  assert.ok(variableInitializerCode(server, 'bootProbeRuntime').includes('new BootProbeRuntime({'));

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

test('server delegates auto retry, run provenance, calibration kind and validation revisions to TimingRuntime', () => {
  for (const expected of [
    'timingRuntime.autoCalibrationDue(nowMs)',
    'timingRuntime.beginContentCalibration(nowMs, true)',
    'timingRuntime.beginContentCalibration(nowMs, false)',
    'timingRuntime.beginBootProbe(true)',
    'timingRuntime.beginBootProbe(false)',
    'timingRuntime.prepareContentValidationSlew(calibration.confirmedRevision + 1)',
    'timingRuntime.markContentValidationBaseline(calibration.confirmedRevision)',
    'automatic: timingRuntime.automatic',
  ]) {
    assert.ok(serverCode.includes(expected), `server must retain TimingRuntime delegation: ${expected}`);
  }
});
