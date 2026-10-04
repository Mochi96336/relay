import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUniqueFunctionSource,
  readRepositoryTextFile,
} from './helpers/source-contract.js';

const product = readRepositoryTextFile('src/product-view-model.ts');

function functionBody(name: string) {
  return findUniqueFunctionSource(name).declaration;
}

test('canonical readiness recognizes either Mic media transport, including WebTransport', () => {
  const body = functionBody('readinessPayload');
  assert.match(body, /micConnected: micMediaConnected\(\)/);
  assert.doesNotMatch(body, /micConnected: publisher\?\.readyState/);
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
  const route = functionBody('robotRouteActive');
  assert.match(route, /backingRuntime\.isRobot \|\| sourceRuntime\.connected\(\)/);
  assert.doesNotMatch(route, /PROBE_CALIBRATE/);

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
    assert.doesNotMatch(
      functionBody(name),
      /robotProbeTimingActive\(\)/,
      `${name} asks whether the room is on a Robot route, so it must read robotRouteActive()`,
    );
  }

  // Content authority and its live-coordinate carry are route questions too.
  const sync = functionBody('syncAppliedCalibration');
  assert.match(sync, /robotContentAuthority = robotRouteActive\(\) && calibrationKind === 'content'/);
  assert.doesNotMatch(functionBody('desiredCalibratedMicLagMs'), /robotProbeTimingActive\(\)/);
});
