import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUniqueFunctionSource,
  readRepositoryTextFile,
} from './helpers/source-contract.js';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const product = readRepositoryTextFile('src/product-view-model.ts');

function functionBody(name: string) {
  return findUniqueFunctionSource(name).declaration;
}

test('canonical readiness recognizes either Mic media transport, including WebTransport', () => {
  const facts = parseTypeScriptSource(new URL('../src/relay-status-facts.ts', import.meta.url),
    readRepositoryTextFile('src/relay-status-facts.ts'));
  const body = functionCode(facts, 'readiness');
  assert.match(body, /micConnected: readers\.mic\.runtime\.connected\(\)/);
  assert.doesNotMatch(body, /micConnected: publisher\?\.readyState/);
  const server = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
    readRepositoryTextFile('src/server.ts'));
  assert.match(variableInitializerCode(server, 'relayStatusFacts'), /runtime: micRuntime/);
  assert.match(functionCode(server, 'readinessPayload'), /relayStatusFacts\.readiness\(nowMs\)/);
});

test('Robot route identity stays separate from Robot player-delta timing dependency', () => {
  assert.doesNotThrow(() => functionBody('robotProbeTimingActive'));
  assert.match(product, /requiresRobotPlayerDelta: boolean/);
  assert.match(product, /!input\.timing\.requiresRobotPlayerDelta \|\| input\.timing\.robotDeltaFresh/);
  assert.doesNotMatch(product, /timing\.robotRoute/);
  // Which alignment needs the delta is a ProductStatus projection rule, tested
  // as behaviour in relay-status-projection.test.ts.
});

/**
 * ARCHITECTURE_BOUNDARIES.md section 7: "a configuration flag that turns off
 * boot probing cannot also turn off Robot content authority, mapping
 * readiness, or Robot Take quality semantics."
 *
 * `robotProbeTimingActive()` answers a strategy question and is allowed to
 * read the flag. Everything that asks whether this room *is* a Robot pair must
 * read the route, or `RELAY_CALIBRATION_PROBE=0` silently retires the mapping
 * on a room plainly running one.
 */
test('the Robot route is a physical fact that no strategy flag may switch off', () => {
  const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
    readRepositoryTextFile('src/relay-robot-mapping-orchestration.ts'));
  const route = functionCode(mapping, 'routeActive');
  assert.match(route, /dependencies\.backing\.isRobot \|\| dependencies\.source\.connected\(\)/);
  assert.doesNotMatch(route, /PROBE_CALIBRATE/);
  assert.match(functionBody('robotRouteActive'), /relayRobotMapping\.routeActive\(\)/);

  // The strategy predicate is the one place the flag belongs.
  assert.match(functionBody('robotProbeTimingActive'), /PROBE_CALIBRATE && robotRouteActive\(\)/);

  for (const name of [
    'robotContentMappingReady',
    'takeQualityFrameState',
    'maybeAutoCalibrate',
    'contentValidationPathReady',
    'dropLegacyCalibrationForRobot',
    'maybeReapplyBootCalibration',
  ]) {
    const declaration = name === 'maybeReapplyBootCalibration'
      ? functionCode(parseTypeScriptSource(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url),
        readRepositoryTextFile('src/relay-boot-probe-orchestration.ts')), name)
      : ['maybeAutoCalibrate', 'contentValidationPathReady'].includes(name)
        ? functionCode(parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
          readRepositoryTextFile('src/relay-calibration-orchestration.ts')), name)
        : functionBody(name);
    if (name === 'maybeReapplyBootCalibration') assert.match(declaration, /queries\.robotRouteActive\(\)/);
    if (['maybeAutoCalibrate', 'contentValidationPathReady'].includes(name)) {
      assert.match(declaration, /queries\.robotRouteActive\(\)/);
    }
    assert.doesNotMatch(
      declaration,
      /robotProbeTimingActive\(\)/,
      `${name} asks whether the room is on a Robot route, so it must read robotRouteActive()`,
    );
  }

  // Content authority and its live-coordinate carry are route questions too.
  const application = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
    readRepositoryTextFile('src/relay-calibration-orchestration.ts'));
  const sync = functionCode(application, 'syncAppliedCalibration');
  assert.match(sync, /robotContentAuthority = queries\.robotRouteActive\(\) && calibrationKind === 'content'/);
  assert.doesNotMatch(functionCode(application, 'desiredCalibratedMicLagMs'), /robotProbeTimingActive\(\)/);
});
