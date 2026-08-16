import type { ReadinessReason, RouteMode } from './readiness.js';

export type RobotReadinessObservation = {
  routeMode: RouteMode;
  reasons: string[];
  backing: {
    connected: boolean;
    streaming: boolean;
    robot: boolean;
  };
  robotSourceConnected: boolean;
};

export type RobotRecoveryConfig = {
  faultGraceMs: number;
  cooldownMs: number;
  budgetWindowMs: number;
  maxRestarts: number;
};

export type RobotRecoveryState = {
  faultKey: string | null;
  faultSinceMs: number | null;
  cooldownUntilMs: number;
  restartHistoryMs: number[];
};

export type RobotRecoveryResult = {
  action: 'none' | 'observe' | 'restart' | 'exhausted';
  cause:
    | 'route-service-inactive'
    | 'healthy'
    | 'non-restartable'
    | 'cooldown'
    | 'grace'
    | 'restart'
    | 'budget-exhausted';
  faults: string[];
  state: RobotRecoveryState;
};

export const RESTARTABLE_ROBOT_REASONS = [
  'backing-not-connected',
  'backing-not-streaming',
  'robot-source-not-connected',
] as const satisfies readonly ReadinessReason[];

const restartableReasons = new Set<string>(RESTARTABLE_ROBOT_REASONS);
const routeModes = new Set<RouteMode>(['idle', 'song', 'legacy', 'robot']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyRobotRecoveryState(): RobotRecoveryState {
  return {
    faultKey: null,
    faultSinceMs: null,
    cooldownUntilMs: 0,
    restartHistoryMs: [],
  };
}

export function parseRobotRecoveryState(value: unknown): RobotRecoveryState | null {
  if (!isRecord(value)) return null;
  if (value.faultKey !== null && typeof value.faultKey !== 'string') return null;
  if (value.faultSinceMs !== null && !Number.isFinite(value.faultSinceMs)) return null;
  if (!Number.isFinite(value.cooldownUntilMs) || Number(value.cooldownUntilMs) < 0) return null;
  if (!Array.isArray(value.restartHistoryMs)) return null;
  if (!value.restartHistoryMs.every((at) => Number.isFinite(at) && Number(at) >= 0)) return null;

  return {
    faultKey: value.faultKey as string | null,
    faultSinceMs: value.faultSinceMs === null ? null : Number(value.faultSinceMs),
    cooldownUntilMs: Number(value.cooldownUntilMs),
    restartHistoryMs: value.restartHistoryMs.map(Number),
  };
}

export function normalizeRobotRecoveryState(value: unknown): RobotRecoveryState {
  return parseRobotRecoveryState(value) ?? emptyRobotRecoveryState();
}

export function clearRobotFaultObservation(state: RobotRecoveryState): RobotRecoveryState {
  return {
    ...state,
    faultKey: null,
    faultSinceMs: null,
  };
}

export function parseRobotReadiness(payload: unknown): RobotReadinessObservation | null {
  if (!isRecord(payload) || !Array.isArray(payload.reasons)) return null;
  if (!payload.reasons.every((reason) => typeof reason === 'string')) return null;

  const components = payload.components;
  if (!isRecord(components) || !isRecord(components.route)) return null;
  const mode = components.route.mode;
  if (typeof mode !== 'string' || !routeModes.has(mode as RouteMode)) return null;

  const backing = components.backing;
  const robotSource = components.robotSource;
  if (!isRecord(backing) || !isRecord(robotSource)) return null;
  if (
    typeof backing.connected !== 'boolean'
    || typeof backing.streaming !== 'boolean'
    || typeof backing.robot !== 'boolean'
    || typeof robotSource.connected !== 'boolean'
  ) return null;

  return {
    routeMode: mode as RouteMode,
    reasons: [...new Set(payload.reasons as string[])].sort(),
    backing: {
      connected: backing.connected,
      streaming: backing.streaming,
      robot: backing.robot,
    },
    robotSourceConnected: robotSource.connected,
  };
}

function trimRestartHistory(history: number[], nowMs: number, windowMs: number) {
  return history.filter((at) => Number.isFinite(at) && at <= nowMs && nowMs - at < windowMs);
}

function robotRouteFaults(observation: RobotReadinessObservation) {
  const faults = new Set<string>(observation.reasons);

  // `/readyz` intentionally reports an idle room as healthy when no backing
  // route is observable. The service manager carries the missing intent: if the
  // Robot route service is active, its backing bridge and source page are
  // expected even when both have disappeared from Relay's in-memory view.
  if (!observation.backing.connected) {
    faults.add('backing-not-connected');
  } else {
    if (!observation.backing.streaming) faults.add('backing-not-streaming');
    if (!observation.backing.robot) faults.add('backing-not-robot');
  }
  if (!observation.robotSourceConnected) faults.add('robot-source-not-connected');

  return [...faults].sort();
}

export function decideRobotRecovery(
  current: RobotRecoveryState,
  observation: RobotReadinessObservation,
  routeServiceActive: boolean,
  nowMs: number,
  config: RobotRecoveryConfig,
): RobotRecoveryResult {
  let state = normalizeRobotRecoveryState(current);
  state = {
    ...state,
    restartHistoryMs: trimRestartHistory(state.restartHistoryMs, nowMs, config.budgetWindowMs),
  };

  // systemd owns whether this route should exist. A deliberately stopped or
  // failed unit is outside semantic-recovery authority; this supervisor never
  // turns `restart` into an implicit `start`.
  if (!routeServiceActive) {
    return {
      action: 'none',
      cause: 'route-service-inactive',
      faults: [],
      state: clearRobotFaultObservation(state),
    };
  }

  const faults = robotRouteFaults(observation);
  if (faults.length === 0) {
    return {
      action: 'none',
      cause: 'healthy',
      faults: [],
      state: clearRobotFaultObservation(state),
    };
  }

  // Fail closed: every active route reason must be explicitly approved for
  // automatic repair. A new readiness reason therefore cannot accidentally
  // inherit restart authority from an older policy.
  if (faults.some((reason) => !restartableReasons.has(reason))) {
    return {
      action: 'none',
      cause: 'non-restartable',
      faults,
      state: clearRobotFaultObservation(state),
    };
  }

  if (nowMs < state.cooldownUntilMs) {
    return {
      action: 'none',
      cause: 'cooldown',
      faults,
      state: clearRobotFaultObservation(state),
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
    ...clearRobotFaultObservation(state),
    cooldownUntilMs: nowMs + config.cooldownMs,
    restartHistoryMs: [...state.restartHistoryMs, nowMs],
  };
  return { action: 'restart', cause: 'restart', faults, state };
}
