import type { RelayObservationStatusV1 } from './observation-status.js';

export type RobotSemanticRecoveryConfig = {
  faultGraceMs: number;
  cooldownMs: number;
  budgetWindowMs: number;
  maxRestarts: number;
};

export type RobotSemanticRecoveryState = {
  faultKey: string | null;
  faultSinceMs: number | null;
  cooldownUntilMs: number;
  restartHistoryMs: number[];
};

export type RobotSemanticRecoveryFault =
  | 'backing-not-connected'
  | 'backing-not-streaming'
  | 'backing-not-robot'
  | 'robot-source-not-connected';

export type RobotSemanticRecoveryResult = {
  action: 'none' | 'observe' | 'restart' | 'exhausted';
  cause:
    | 'route-service-inactive'
    | 'healthy'
    | 'non-restartable'
    | 'cooldown'
    | 'grace'
    | 'restart'
    | 'budget-exhausted';
  faults: RobotSemanticRecoveryFault[];
  state: RobotSemanticRecoveryState;
};

const RESTARTABLE_FAULTS = new Set<RobotSemanticRecoveryFault>([
  'backing-not-connected',
  'backing-not-streaming',
  'robot-source-not-connected',
]);

export function emptyRobotSemanticRecoveryState(): RobotSemanticRecoveryState {
  return {
    faultKey: null,
    faultSinceMs: null,
    cooldownUntilMs: 0,
    restartHistoryMs: [],
  };
}

export function parseRobotSemanticRecoveryState(value: unknown): RobotSemanticRecoveryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.faultKey !== null && typeof state.faultKey !== 'string') return null;
  if (state.faultSinceMs !== null && !Number.isFinite(state.faultSinceMs)) return null;
  if (!Number.isFinite(state.cooldownUntilMs) || Number(state.cooldownUntilMs) < 0) return null;
  if (!Array.isArray(state.restartHistoryMs)) return null;
  if (!state.restartHistoryMs.every((at) => Number.isFinite(at) && Number(at) >= 0)) return null;

  return {
    faultKey: state.faultKey as string | null,
    faultSinceMs: state.faultSinceMs === null ? null : Number(state.faultSinceMs),
    cooldownUntilMs: Number(state.cooldownUntilMs),
    restartHistoryMs: state.restartHistoryMs.map(Number),
  };
}

function clearFaultObservation(state: RobotSemanticRecoveryState): RobotSemanticRecoveryState {
  return {
    ...state,
    faultKey: null,
    faultSinceMs: null,
  };
}

function trimRestartHistory(history: number[], nowMs: number, windowMs: number) {
  return history.filter((at) => at <= nowMs && nowMs - at < windowMs);
}

/**
 * Derives only robot-local physical faults from the stable observation contract.
 * Phone, Mic, timeline, calibration, player-delta and generic issue strings are
 * deliberately outside automatic restart authority.
 */
export function robotSemanticRecoveryFaults(
  observation: RelayObservationStatusV1,
): RobotSemanticRecoveryFault[] {
  const faults: RobotSemanticRecoveryFault[] = [];
  const backing = observation.sources.backing;
  const robot = observation.sources.robot;

  if (!backing.connected) {
    faults.push('backing-not-connected');
  } else {
    if (!backing.streaming) faults.push('backing-not-streaming');
    if (!backing.robot) faults.push('backing-not-robot');
  }
  if (!robot.sourceConnected) faults.push('robot-source-not-connected');

  return faults.sort();
}

/**
 * Decides whether the existing robot-source systemd unit may be restarted.
 *
 * systemd ActiveState is the intent boundary: an inactive/stopped route is never
 * implicitly started here. Relay observation contributes only physical evidence.
 * Every active physical fault must be explicitly allowlisted before restart
 * authority exists, so new observation fields or issue strings cannot inherit it.
 */
export function decideRobotSemanticRecovery(
  current: RobotSemanticRecoveryState,
  observation: RelayObservationStatusV1,
  routeServiceActive: boolean,
  nowMs: number,
  config: RobotSemanticRecoveryConfig,
): RobotSemanticRecoveryResult {
  let state: RobotSemanticRecoveryState = {
    ...current,
    restartHistoryMs: trimRestartHistory(current.restartHistoryMs, nowMs, config.budgetWindowMs),
  };

  if (!routeServiceActive) {
    return {
      action: 'none',
      cause: 'route-service-inactive',
      faults: [],
      state: clearFaultObservation(state),
    };
  }

  const faults = robotSemanticRecoveryFaults(observation);
  if (faults.length === 0) {
    return {
      action: 'none',
      cause: 'healthy',
      faults: [],
      state: clearFaultObservation(state),
    };
  }

  if (faults.some((fault) => !RESTARTABLE_FAULTS.has(fault))) {
    return {
      action: 'none',
      cause: 'non-restartable',
      faults,
      state: clearFaultObservation(state),
    };
  }

  if (nowMs < state.cooldownUntilMs) {
    return {
      action: 'none',
      cause: 'cooldown',
      faults,
      state: clearFaultObservation(state),
    };
  }

  const faultKey = faults.join('|');
  if (state.faultKey !== faultKey || state.faultSinceMs === null) {
    state = {
      ...state,
      faultKey,
      faultSinceMs: nowMs,
    };
    return { action: 'observe', cause: 'grace', faults, state };
  }

  if (nowMs - state.faultSinceMs < config.faultGraceMs) {
    return { action: 'observe', cause: 'grace', faults, state };
  }

  if (state.restartHistoryMs.length >= config.maxRestarts) {
    return {
      action: 'exhausted',
      cause: 'budget-exhausted',
      faults,
      state,
    };
  }

  state = {
    ...clearFaultObservation(state),
    cooldownUntilMs: nowMs + config.cooldownMs,
    restartHistoryMs: [...state.restartHistoryMs, nowMs],
  };
  return { action: 'restart', cause: 'restart', faults, state };
}
