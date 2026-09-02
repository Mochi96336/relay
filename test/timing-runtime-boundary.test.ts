import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/timing-runtime.ts', import.meta.url), 'utf8');

test('TimingRuntime owns orchestration metadata without absorbing timing authorities', () => {
  assert.match(server, /new TimingRuntime\(\{[\s\S]{0,160}autoCalibrationRetryMs:\s*AUTO_CALIBRATION_RETRY_MS/);
  assert.doesNotMatch(server, /let\s+(?:lastAutoCalibrationAt|calibrationWasAutomatic|calibrationKind|contentValidationBaselineRevision|contentValidationSlewRevision)\b/);

  assert.match(server, /const calibration = new CalibrationSession\(\{/);
  assert.match(server, /const contentCalibrationValidator = new ContentCalibrationValidator\(\{/);
  assert.match(server, /const bootProbeRuntime = new BootProbeRuntime\(\{/);

  const imports = [...runtime.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"];?$/gm)].map((match) => match[1]);
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
  assert.match(server, /timingRuntime\.autoCalibrationDue\(nowMs\)/);
  assert.match(server, /timingRuntime\.beginContentCalibration\(nowMs, true\)/);
  assert.match(server, /timingRuntime\.beginContentCalibration\(nowMs, false\)/);
  assert.match(server, /timingRuntime\.beginBootProbe\(true\)/);
  assert.match(server, /timingRuntime\.beginBootProbe\(false\)/);
  assert.match(server, /timingRuntime\.prepareContentValidationSlew\(calibration\.confirmedRevision \+ 1\)/);
  assert.match(server, /timingRuntime\.markContentValidationBaseline\(calibration\.confirmedRevision\)/);
  assert.match(server, /automatic: timingRuntime\.automatic/);
});
