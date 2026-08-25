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
import { RelayClient, sleep, startRelay } from './helpers/harness.js';

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
  assert.equal(robotContentTransitionBoundsStatus(bounds, 2_000).deadlineRemainingMs, 0);
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

async function waitForServerTransition(
  monitor: RelayClient,
  predicate: (status: Record<string, any>) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    const from = monitor.messages.length;
    monitor.send({ type: 'timing-calibration-status-request' });
    await sleep(50);
    const statuses = monitor.messages
      .slice(from)
      .filter((message) => message.type === 'timing-calibration-status');
    last = statuses.at(-1) ?? last;
    const match = statuses.find(predicate);
    if (match) return match;
  }
  throw new Error(`Timed out waiting for Robot transition status. Last=${JSON.stringify(last ?? null)}`);
}

function boundaryRequestCount(backing: RelayClient) {
  return backing.messages.filter((message) => message.type === 'backing-sample-boundary-request').length;
}

test('server deadline makes quarantine terminal and a later follower correction starts a fresh budget', async () => {
  const server = await startRelay({
    RELAY_CALIBRATION_PROBE: '1',
    RELAY_ROBOT_CONTENT_TRANSITION_LIFETIME_MS: '600',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WINDOWS: '3',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES: '2',
    RELAY_HEARTBEAT_MS: '60000',
  });
  const backing = await RelayClient.connect(server);
  const publisher = await RelayClient.connect(server);
  const robot = await RelayClient.connect(server);
  const monitor = await RelayClient.connect(server);

  try {
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');
    robot.send({ type: 'robot-source-hello' });
    monitor.send({ type: 'register', role: 'monitor' });
    await monitor.waitForType('registered');

    robot.send({ type: 'robot-player-offset', offsetMs: 500 });
    await sleep(50);
    robot.send({
      type: 'source-seeked',
      reason: 'follower-correction',
      fromMediaTime: 100.5,
      toMediaTime: 100,
    });

    const verifying = await waitForServerTransition(
      monitor,
      (status) => status.robotContentTransition?.state === 'verifying',
      2_000,
    );
    const firstStartedAtMs = Number(verifying.robotContentTransition.startedAtMs);
    assert.equal(verifying.robotContentTransition.quarantined, true);
    assert.equal(verifying.robotContentTransition.workerInvocations, 0);

    const degraded = await waitForServerTransition(
      monitor,
      (status) => status.robotContentTransition?.state === 'degraded',
      3_000,
    );
    assert.equal(degraded.robotContentTransition.degradedReason, 'deadline-exceeded');
    assert.equal(degraded.robotContentTransition.quarantined, true);
    assert.equal(degraded.robotContentTransition.workerInvocations, 0);

    const requestsAtDegrade = boundaryRequestCount(backing);
    robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    await sleep(300);
    assert.equal(
      boundaryRequestCount(backing),
      requestsAtDegrade,
      'a degraded transition must not restart backing-boundary churn from fresh telemetry alone',
    );

    robot.send({
      type: 'source-seeked',
      reason: 'follower-correction',
      fromMediaTime: 100.25,
      toMediaTime: 100,
    });
    const restarted = await waitForServerTransition(
      monitor,
      (status) => status.robotContentTransition?.state === 'verifying'
        && Number(status.robotContentTransition.startedAtMs) > firstStartedAtMs,
      2_000,
    );
    assert.equal(restarted.robotContentTransition.windowsStarted, 0);
    assert.equal(restarted.robotContentTransition.workerFailures, 0);
    assert.equal(restarted.robotContentTransition.degradedReason, null);
  } finally {
    monitor.close();
    robot.close();
    publisher.close();
    backing.close();
    await server.stop();
  }
});
