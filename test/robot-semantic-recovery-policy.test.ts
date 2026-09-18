import assert from 'node:assert/strict';
import test from 'node:test';

import type { RelayObservationStatusV1 } from '../src/observation-status.js';
import {
  decideRobotSemanticRecovery,
  emptyRobotSemanticRecoveryState,
  parseRobotSemanticRecoveryState,
  robotSemanticRecoveryFaults,
  type RobotSemanticRecoveryConfig,
  type RobotSemanticRecoveryState,
} from '../src/robot-semantic-recovery-policy.js';

const config: RobotSemanticRecoveryConfig = {
  faultGraceMs: 30_000,
  cooldownMs: 60_000,
  budgetWindowMs: 10 * 60_000,
  maxRestarts: 3,
};

function observation(overrides: {
  state?: RelayObservationStatusV1['workload']['state'];
  backingConnected?: boolean;
  backingStreaming?: boolean;
  backingRobot?: boolean;
  robotRouteActive?: boolean;
  robotSourceConnected?: boolean;
  playerDeltaFresh?: boolean;
  faults?: string[];
  warnings?: string[];
} = {}): RelayObservationStatusV1 {
  return {
    schema: 'relay.observation.v1',
    generatedAt: '2026-09-08T00:00:00.000Z',
    workload: {
      id: 'relay',
      state: overrides.state ?? 'live',
      ok: (overrides.faults?.length ?? 0) === 0,
      uptimeMs: 123_000,
    },
    activity: {
      sessionActive: true,
      participants: { total: 1, connected: 1 },
      microphoneLease: { held: true, transportConnected: true },
    },
    sources: {
      backing: {
        connected: overrides.backingConnected ?? true,
        streaming: overrides.backingStreaming ?? true,
        sampleRate: 48_000,
        robot: overrides.backingRobot ?? true,
        frameAgeMs: 20,
      },
      microphone: {
        connected: true,
        streaming: true,
        sampleRate: 48_000,
        frameAgeMs: 20,
      },
      robot: {
        routeActive: overrides.robotRouteActive ?? true,
        sourceConnected: overrides.robotSourceConnected ?? true,
        playerDeltaFresh: overrides.playerDeltaFresh ?? true,
      },
    },
    calibration: {
      kind: 'content',
      stale: false,
      timingMode: 'acoustic-calibration',
      activeCalibratedMicLagMs: 100,
    },
    mix: {
      active: true,
      micStarvedFrames: 0,
      backingStarvedFrames: 0,
      micHeadroomMs: 100,
      backingHeadroomMs: 100,
      micGapMs: 0,
      backingGapMs: 0,
      clippedSamples: 0,
      limitedSamples: 0,
      micPeakDbfs: -12,
      micRmsDbfs: -24,
      unheadered: false,
      monitorDroppedFrames: 0,
    },
    issues: {
      faults: overrides.faults ?? [],
      warnings: overrides.warnings ?? [],
    },
  };
}

function decide(
  state: RobotSemanticRecoveryState,
  currentObservation: RelayObservationStatusV1,
  serviceActive: boolean,
  nowMs: number,
) {
  return decideRobotSemanticRecovery(state, currentObservation, serviceActive, nowMs, config);
}

test('physical route faults come only from stable robot-local observation fields', () => {
  const current = observation({
    backingStreaming: false,
    robotSourceConnected: false,
    playerDeltaFresh: false,
    faults: ['mic-not-streaming', 'calibration-missing', 'future-unknown-fault'],
    warnings: ['robot-player-offset-stale'],
  });

  assert.deepEqual(robotSemanticRecoveryFaults(current), [
    'backing-not-streaming',
    'robot-source-not-connected',
  ]);
});

test('an intentionally inactive route service never receives implicit start authority', () => {
  const result = decide(
    emptyRobotSemanticRecoveryState(),
    observation({ backingConnected: false, robotSourceConnected: false, state: 'idle' }),
    false,
    100_000,
  );

  assert.equal(result.action, 'none');
  assert.equal(result.cause, 'route-service-inactive');
  assert.deepEqual(result.faults, []);
});

test('complete route disappearance is recoverable even when Relay observation is idle', () => {
  let state = emptyRobotSemanticRecoveryState();
  const missing = observation({
    state: 'idle',
    backingConnected: false,
    robotSourceConnected: false,
    robotRouteActive: false,
  });

  const first = decide(state, missing, true, 100_000);
  assert.equal(first.action, 'observe');
  assert.deepEqual(first.faults, ['backing-not-connected', 'robot-source-not-connected']);
  state = first.state;

  const beforeGrace = decide(state, missing, true, 129_999);
  assert.equal(beforeGrace.action, 'observe');

  const atGrace = decide(beforeGrace.state, missing, true, 130_000);
  assert.equal(atGrace.action, 'restart');
  assert.equal(atGrace.cause, 'restart');
  assert.equal(atGrace.state.restartHistoryMs.length, 1);
});

test('a transient physical fault that recovers loses its continuous-fault evidence', () => {
  const missing = observation({ backingConnected: false });
  const observed = decide(emptyRobotSemanticRecoveryState(), missing, true, 10_000);
  assert.equal(observed.action, 'observe');

  const healthy = decide(observed.state, observation(), true, 20_000);
  assert.equal(healthy.action, 'none');
  assert.equal(healthy.cause, 'healthy');
  assert.equal(healthy.state.faultKey, null);
  assert.equal(healthy.state.faultSinceMs, null);

  const missingAgain = decide(healthy.state, missing, true, 35_000);
  assert.equal(missingAgain.action, 'observe');
  assert.equal(missingAgain.state.faultSinceMs, 35_000);
});

test('a changed physical fault must earn a fresh grace interval', () => {
  const backingMissing = observation({ backingConnected: false });
  const sourceMissing = observation({ robotSourceConnected: false });
  const first = decide(emptyRobotSemanticRecoveryState(), backingMissing, true, 10_000);
  const changed = decide(first.state, sourceMissing, true, 39_000);

  assert.equal(changed.action, 'observe');
  assert.equal(changed.state.faultSinceMs, 39_000);
  assert.equal(changed.state.faultKey, 'robot-source-not-connected');
});

test('a non-Robot backing identity fails closed even when another restartable fault exists', () => {
  const result = decide(
    emptyRobotSemanticRecoveryState(),
    observation({ backingRobot: false, robotSourceConnected: false }),
    true,
    100_000,
  );

  assert.equal(result.action, 'none');
  assert.equal(result.cause, 'non-restartable');
  assert.deepEqual(result.faults, ['backing-not-robot', 'robot-source-not-connected']);
});

test('phone, Mic, calibration and player-delta problems never grant restart authority', () => {
  const result = decide(
    emptyRobotSemanticRecoveryState(),
    observation({
      playerDeltaFresh: false,
      faults: ['mic-not-streaming', 'phone-not-playing', 'calibration-missing'],
      warnings: ['calibration-stale'],
    }),
    true,
    100_000,
  );

  assert.equal(result.action, 'none');
  assert.equal(result.cause, 'healthy');
  assert.deepEqual(result.faults, []);
});

test('cooldown suppresses action and requires fresh continuous evidence afterward', () => {
  const current: RobotSemanticRecoveryState = {
    faultKey: 'backing-not-connected',
    faultSinceMs: 1_000,
    cooldownUntilMs: 100_000,
    restartHistoryMs: [40_000],
  };
  const missing = observation({ backingConnected: false });

  const during = decide(current, missing, true, 90_000);
  assert.equal(during.action, 'none');
  assert.equal(during.cause, 'cooldown');
  assert.equal(during.state.faultSinceMs, null);

  const after = decide(during.state, missing, true, 100_000);
  assert.equal(after.action, 'observe');
  assert.equal(after.state.faultSinceMs, 100_000);
});

test('restart budget exhausts inside its window and old attempts age out', () => {
  const missing = observation({ backingConnected: false });
  const exhaustedState: RobotSemanticRecoveryState = {
    faultKey: 'backing-not-connected',
    faultSinceMs: 970_000,
    cooldownUntilMs: 0,
    restartHistoryMs: [500_000, 600_000, 700_000],
  };

  const exhausted = decide(exhaustedState, missing, true, 1_000_000);
  assert.equal(exhausted.action, 'exhausted');
  assert.equal(exhausted.cause, 'budget-exhausted');
  assert.equal(exhausted.state.restartHistoryMs.length, 3);

  const agedState: RobotSemanticRecoveryState = {
    faultKey: 'backing-not-connected',
    faultSinceMs: 1_570_000,
    cooldownUntilMs: 0,
    restartHistoryMs: [500_000, 600_000, 700_000],
  };
  const aged = decide(agedState, missing, true, 1_600_000);
  assert.equal(aged.action, 'restart');
  assert.deepEqual(aged.state.restartHistoryMs, [1_600_000]);
});

test('persisted policy state parser rejects malformed safety-budget state', () => {
  assert.equal(parseRobotSemanticRecoveryState(null), null);
  assert.equal(parseRobotSemanticRecoveryState({}), null);
  assert.equal(parseRobotSemanticRecoveryState({
    faultKey: null,
    faultSinceMs: null,
    cooldownUntilMs: 0,
    restartHistoryMs: ['not-a-number'],
  }), null);

  assert.deepEqual(parseRobotSemanticRecoveryState({
    faultKey: 'backing-not-connected',
    faultSinceMs: 100,
    cooldownUntilMs: 200,
    restartHistoryMs: [10, 20],
  }), {
    faultKey: 'backing-not-connected',
    faultSinceMs: 100,
    cooldownUntilMs: 200,
    restartHistoryMs: [10, 20],
  });
});
