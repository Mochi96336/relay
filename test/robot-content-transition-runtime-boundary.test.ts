import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtime = readFileSync(
  new URL('../src/robot-content-transition-runtime.ts', import.meta.url),
  'utf8',
);

test('RobotContentTransitionRuntime owns quarantine control without absorbing timing authorities', () => {
  assert.match(runtime, /robot-content-transition-bounds\.js/);
  assert.match(runtime, /robot-content-transition-worker-client\.js/);

  const imports = [...runtime.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm)]
    .map((match) => match[1]);
  for (const forbidden of [
    './audio-session.js',
    './calibration-session.js',
    './content-calibration-validator.js',
    './timing-runtime.js',
    './robot-content-timeline.js',
    './robot-player-offset.js',
    './probe-lifecycle.js',
    './song-session.js',
    './take-controller.js',
  ]) {
    assert.equal(
      imports.includes(forbidden),
      false,
      `RobotContentTransitionRuntime must not absorb authority from ${forbidden}`,
    );
  }
});
