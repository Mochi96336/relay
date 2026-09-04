import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function functionBlock(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = server.indexOf('\nfunction ', start + 1);
  return server.slice(start, next === -1 ? server.length : next);
}

test('successful boot probe is a baseline that may promote to automatic content authority', () => {
  const block = functionBlock('maybeAutoCalibrate');
  assert.match(block, /bootProbeRuntime\.pathDifferenceMs !== null/);
  assert.match(block, /bootProbeRuntime\.completedContextMatches\(bootProbeContext\(\)\)/);
  assert.match(block, /!exhaustedRobotProbe && !completedBootBaseline/);
  assert.match(block, /appliedCalibrationKind\(\) === 'content'/);
  assert.doesNotMatch(
    block,
    /if \(calibration\.confirmedResult !== null && !calibrationIsStale\(\)\) return;/,
    'a fresh boot result must not be mistaken for terminal content authority',
  );
});

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

test('gross Robot offset is revoked before boot-probe can fold it into mixer timing', () => {
  assert.match(server, /const ROBOT_PLAYER_OFFSET_MAX_ABS_MS = 5_000;/);
  assert.match(
    server,
    /Math\.abs\(offsetMs\) > ROBOT_PLAYER_OFFSET_MAX_ABS_MS[\s\S]*?robotPlayerOffset\.reset\(\)[\s\S]*?robotContentTimeline\.reset\(\)[\s\S]*?clearRobotContentTransition\(\)/,
  );
});

test('degraded transition releases quarantine and invalidates the stale reference frame', () => {
  assert.match(
    server,
    /onDegraded: \(status\) => \{[\s\S]*?robotPlayerOffset\.reset\(\)[\s\S]*?robotContentTimeline\.reset\(\)[\s\S]*?sourceRuntime\.invalidateMapping\(\)[\s\S]*?clearRobotContentTransition\(\)/,
  );
});
