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
const runtime = parseTypeScriptSource(
  new URL('../src/timing-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/timing-runtime.ts', import.meta.url), 'utf8'),
);
const application = parseTypeScriptSource(
  new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'),
);
const serverCode = sourceCode(server);
const workflow = parseTypeScriptSource(
  new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url), 'utf8'),
);

test('TimingRuntime owns orchestration metadata without absorbing timing authorities', () => {
  const construction = variableInitializerCode(server, 'timingRuntime');
  assert.ok(construction.includes('new TimingRuntime({'));
  assert.ok(construction.includes('autoCalibrationRetryMs: AUTO_CALIBRATION_RETRY_MS'));
  assert.doesNotMatch(
    serverCode,
    /let\s+(?:lastAutoCalibrationAt|calibrationWasAutomatic|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/,
  );
  assert.doesNotMatch(sourceCode(workflow), /let\s+(?:lastAutoCalibrationAt|calibrationWasAutomatic|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/);
  assert.match(variableInitializerCode(server, 'relayBootProbe'), /timing: timingRuntime/);
  assert.match(variableInitializerCode(server, 'relayCalibration'), /timing: timingRuntime/);
  assert.match(variableInitializerCode(server, 'relayContentCalibration'), /timing: timingRuntime/);
  assert.match(variableInitializerCode(server, 'relayCalibrationLifecycle'), /timing: timingRuntime/);
  assert.doesNotMatch(sourceCode(application), /new TimingRuntime\(|let\s+(?:lastAutoCalibrationAt|calibrationWasAutomatic|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/);
  assert.doesNotMatch(sourceCode(workflow), /new TimingRuntime\(/);

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
    'timingRuntime.beginContentCalibration(nowMs, false)',
    'timingRuntime.prepareContentValidationSlew(calibration.confirmedRevision + 1)',
    'timingRuntime.markContentValidationBaseline(calibration.confirmedRevision)',
    'automatic: timingRuntime.automatic',
  ]) {
    assert.ok(serverCode.includes(expected), `server must retain TimingRuntime delegation: ${expected}`);
  }
  assert.ok(functionCode(workflow, 'sendProbeRequest').includes('timingRuntime.beginBootProbe(true)'),
    'automatic probe workflow must retain the same canonical TimingRuntime delegation');
  assert.ok(variableInitializerCode(application, 'manualBootRecalibrationCoordinator')
    .includes('timingRuntime.beginBootProbe(false)'),
  'manual lifecycle must retain the canonical nonautomatic TimingRuntime delegation');
  for (const expected of ['timingRuntime.autoCalibrationDue(nowMs)',
    'timingRuntime.beginContentCalibration(nowMs, true)']) {
    assert.ok(functionCode(application, 'maybeAutoCalibrate').includes(expected),
      `canonical content workflow must retain TimingRuntime delegation: ${expected}`);
  }
});
