import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Structural rules for Robot bootstrap timing that the server-side harness
 * cannot observe directly.
 *
 * The behaviour these used to approximate - a successful boot probe promoting
 * to content authority, reaching the mixer, and arming drift validation - is
 * covered for real in `robot-boot-to-content-promotion.test.ts`, which runs the
 * scheduler instead of reading it. What is left here is provenance and the
 * single-teardown rule: claims about which code path owns a decision, where a
 * matching assertion is the honest tool and a passing regex is not mistaken for
 * a working state machine.
 */

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function functionBlock(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = server.indexOf('\nfunction ', start + 1);
  return server.slice(start, next === -1 ? server.length : next);
}

test('boot-probe result cannot impersonate a confirmed content transition anchor', () => {
  const begin = functionBlock('beginRobotContentTransition');
  const reconcile = functionBlock('reconcileRobotContentTransitionWithFreshDelta');
  for (const block of [begin, reconcile]) {
    assert.match(block, /appliedCalibrationKind\(\) === 'content'/);
    assert.match(block, /!calibrationIsStale\(\)/);
    assert.doesNotMatch(
      block,
      /timingRuntime\.calibrationKind === 'content'/,
      'candidate content mode must not relabel a retained boot-probe result as content authority',
    );
  }
});

test('content provenance is read from applied authority, never the in-flight candidate', () => {
  // `CalibrationSession.start()` deliberately keeps the previous confirmed
  // result serving while a replacement is measured, so `candidate = content`
  // alongside `confirmed = boot-probe` is an ordinary state. Reading the
  // candidate for provenance installs a boot measurement as the baseline that
  // content drift is judged against.
  for (const name of ['syncContentValidationBaseline', 'contentValidationPathReady']) {
    const block = functionBlock(name);
    assert.match(block, /appliedCalibrationKind\(\) !== 'content'/, `${name} must read applied authority`);
    assert.doesNotMatch(
      block,
      /timingRuntime\.calibrationKind !== 'content'/,
      `${name} must not treat the in-flight candidate as provenance`,
    );
  }
});

test('content gates ask whether the boot probe settled, not whether it failed', () => {
  // A probe that succeeds never reports an error, so a gate keyed on probe
  // failure stays shut forever on the healthy path - which is what left content
  // permanently un-appliable and drift validation permanently unarmed.
  for (const name of [
    'maybeAutoCalibrate',
    'calibrationCanApply',
    'contentValidationPathReady',
    'dropLegacyCalibrationForRobot',
  ]) {
    const block = functionBlock(name);
    assert.match(block, /bootProbeSettled\(/, `${name} must gate on boot probe settlement`);
  }

  const settled = functionBlock('bootProbeSettled');
  assert.match(settled, /probeCalibrationExhausted\(nowMs\)/, 'exhaustion is one way to settle');
  assert.match(
    settled,
    /bootProbeRuntime\.pathDifferenceMs !== null/,
    'a completed baseline is the other way to settle',
  );
  assert.match(settled, /completedContextMatches\(bootProbeContext\(\)\)/);
});

test('every Robot mapping revocation goes through one teardown transaction', () => {
  // This used to be an open-coded checklist repeated per event, and no two
  // copies cleared the same subset - so fixing one path kept leaving the others
  // holding state that had just been proven wrong.
  const revoke = functionBlock('revokeRobotContentMapping');
  for (const step of [
    /robotPlayerOffset\.reset\(\)/,
    /robotContentTimeline\.reset\(\)/,
    /clearRobotContentTransition\(\)/,
    /sourceRuntime\.invalidateMapping\(\)/,
    /calibration\.discardPrimedContent\(\)/,
    /clearContentValidationBaseline\(\)/,
    /syncAppliedCalibration\(\)/,
  ]) {
    assert.match(revoke, step, 'the revocation transaction must own every teardown step');
  }
  assert.match(
    revoke,
    /if \(calibration\.collecting\) calibration\.fail\(reason\)/,
    'a revocation must abort the pending analyzer, which is stamped with the context live at completion',
  );

  // The two inline fences must delegate rather than re-spell the checklist.
  assert.match(
    server,
    /Math\.abs\(offsetMs\) > ROBOT_PLAYER_OFFSET_MAX_ABS_MS\)\s*\{[\s\S]{0,600}?revokeRobotContentMapping\(\{/,
    'the gross-offset fence must revoke through the shared transaction, including the generation bump',
  );
  assert.match(
    server,
    /onDegraded: \(status\) => \{[\s\S]*?revokeRobotContentMapping\(\{/,
    'a degraded transition must revoke through the shared transaction',
  );
  assert.match(
    server,
    /revokeContentMapping: \(reason\) => revokeRobotContentMapping\(\{ reason \}\)/,
    'a destructive Source seek must revoke through the shared transaction',
  );
});

test('losing the Robot source aborts a calibration measured in the old reference frame', () => {
  // `detachRobot()` / a replacing `attachRobot()` bump the source generation,
  // while `CalibrationSession` stamps its promotion with the context that is
  // live when the async worker answers. Without an explicit abort, evidence
  // measured under the old generation is promoted under the new one.
  const disconnect = readFileSync(
    new URL('../src/relay-robot-disconnect-coordinator.ts', import.meta.url),
    'utf8',
  );
  const activation = readFileSync(
    new URL('../src/relay-robot-activation-coordinator.ts', import.meta.url),
    'utf8',
  );
  assert.match(disconnect, /options\.failCalibrationIfCollecting\(\)/);
  assert.match(activation, /dependencies\.failCalibrationIfCollecting\(\)/);
});
