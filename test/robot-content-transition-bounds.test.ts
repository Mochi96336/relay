import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  beginRobotContentTransitionWorker,
  carryOrCreateRobotContentTransitionBounds,
  createRobotContentTransitionBounds,
  noteRobotContentTransitionVerdict,
  noteRobotContentTransitionWorkerFailure,
  robotContentTransitionBoundsStatus,
  sweepRobotContentTransitionBounds,
} from '../src/robot-content-transition-bounds.js';
import { compareRobotContentHypotheses } from '../src/robot-content-transition.js';

const CONFIG = {
  lifetimeMs: 10_000,
  maxWindows: 3,
  maxWorkerFailures: 2,
};
const RATE = 48_000;
const WINDOW_SAMPLES = Math.round(RATE * 0.65);

test('permanently ambiguous evidence reaches a terminal max-window state without unbounded worker churn', () => {
  const bounds = createRobotContentTransitionBounds(0, CONFIG);
  const silence = new Int16Array(WINDOW_SAMPLES);

  for (let window = 0; window < CONFIG.maxWindows; window += 1) {
    assert.equal(beginRobotContentTransitionWorker(bounds, 'compare', window * 100), true);
    const comparison = compareRobotContentHypotheses(silence, silence, silence, RATE);
    assert.equal(comparison.verdict, 'ambiguous');
    assert.equal(noteRobotContentTransitionVerdict(bounds, comparison.verdict), true);
  }

  assert.equal(beginRobotContentTransitionWorker(bounds, 'compare', 500), false);
  const terminal = robotContentTransitionBoundsStatus(bounds, 500);
  assert.equal(terminal.state, 'degraded');
  assert.equal(terminal.degradedReason, 'max-windows');
  assert.equal(terminal.windowsStarted, CONFIG.maxWindows);
  assert.equal(terminal.workerInvocations, CONFIG.maxWindows);

  for (let retry = 0; retry < 20; retry += 1) {
    assert.equal(beginRobotContentTransitionWorker(bounds, 'compare', 600 + retry), false);
  }
  assert.equal(bounds.workerInvocations, CONFIG.maxWindows);
});

test('repeated comparison worker failures fail closed at a bounded retry count', () => {
  const bounds = createRobotContentTransitionBounds(0, CONFIG);

  assert.equal(beginRobotContentTransitionWorker(bounds, 'compare', 10), true);
  assert.equal(noteRobotContentTransitionWorkerFailure(bounds, 'compare', 20), false);
  assert.equal(bounds.phase, 'verifying');

  assert.equal(beginRobotContentTransitionWorker(bounds, 'compare', 30), true);
  assert.equal(noteRobotContentTransitionWorkerFailure(bounds, 'compare', 40), true);
  assert.equal(bounds.phase, 'degraded');
  assert.equal(bounds.degradedReason, 'worker-failures');
  assert.equal(bounds.workerFailures, CONFIG.maxWorkerFailures);
  assert.equal(bounds.workerInvocations, CONFIG.maxWorkerFailures);

  assert.equal(beginRobotContentTransitionWorker(bounds, 'compare', 50), false);
  assert.equal(bounds.workerInvocations, CONFIG.maxWorkerFailures);
});

test('silence with no complete evidence window still reaches the wall-clock deadline', () => {
  const bounds = createRobotContentTransitionBounds(1_000, {
    ...CONFIG,
    lifetimeMs: 750,
  });

  assert.equal(sweepRobotContentTransitionBounds(bounds, 1_749), false);
  assert.equal(bounds.phase, 'verifying');
  assert.equal(sweepRobotContentTransitionBounds(bounds, 1_750), true);
  assert.equal(bounds.phase, 'degraded');
  assert.equal(bounds.degradedReason, 'deadline-exceeded');
  assert.equal(bounds.workerInvocations, 0);
});

test('anchor worker failure is terminal and cannot be mistaken for a content hypothesis', () => {
  const bounds = createRobotContentTransitionBounds(0, CONFIG);
  assert.equal(beginRobotContentTransitionWorker(bounds, 'anchor', 10), true);
  assert.equal(noteRobotContentTransitionWorkerFailure(bounds, 'anchor', 20), true);
  assert.equal(bounds.phase, 'degraded');
  assert.equal(bounds.degradedReason, 'anchor-worker-failure');
  assert.equal(bounds.lastVerdict, null);
  assert.equal(bounds.workerInvocations, 1);
});

test('a later concrete transition gets a fresh budget after a degraded predecessor', () => {
  const old = createRobotContentTransitionBounds(0, {
    ...CONFIG,
    maxWindows: 1,
  });
  assert.equal(beginRobotContentTransitionWorker(old, 'compare', 10), true);
  noteRobotContentTransitionVerdict(old, 'ambiguous');
  assert.equal(beginRobotContentTransitionWorker(old, 'compare', 20), false);
  assert.equal(old.phase, 'degraded');

  const next = carryOrCreateRobotContentTransitionBounds(old, 1_000, CONFIG);
  assert.equal(next.phase, 'verifying');
  assert.equal(next.startedAtMs, 1_000);
  assert.equal(next.windowsStarted, 0);
  assert.equal(next.workerInvocations, 0);
  assert.equal(next.workerFailures, 0);
  assert.equal(next.degradedReason, null);

  assert.equal(beginRobotContentTransitionWorker(next, 'compare', 1_010), true);
  assert.equal(noteRobotContentTransitionVerdict(next, 'post'), true);
  assert.equal(next.phase, 'verifying');
  assert.equal(next.lastVerdict, 'post');
});
