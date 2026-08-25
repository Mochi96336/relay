import type { RobotContentTransitionVerdict } from './robot-content-transition.js';

export type RobotContentTransitionPhase = 'verifying' | 'degraded';

export type RobotContentTransitionDegradedReason =
  | 'deadline-exceeded'
  | 'max-windows'
  | 'worker-failures'
  | 'anchor-worker-failure';

export type RobotContentTransitionBoundsConfig = {
  lifetimeMs: number;
  maxWindows: number;
  maxWorkerFailures: number;
};

export type RobotContentTransitionBounds = {
  startedAtMs: number;
  deadlineMs: number;
  maxWindows: number;
  maxWorkerFailures: number;
  windowsStarted: number;
  workerInvocations: number;
  workerFailures: number;
  lastVerdict: RobotContentTransitionVerdict | null;
  phase: RobotContentTransitionPhase;
  degradedReason: RobotContentTransitionDegradedReason | null;
  degradedAtMs: number | null;
};

function validPositive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

function validPositiveInt(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export function createRobotContentTransitionBounds(
  nowMs: number,
  config: RobotContentTransitionBoundsConfig,
): RobotContentTransitionBounds {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be finite.');
  const lifetimeMs = validPositive(config.lifetimeMs, 'lifetimeMs');
  return {
    startedAtMs: nowMs,
    deadlineMs: nowMs + lifetimeMs,
    maxWindows: validPositiveInt(config.maxWindows, 'maxWindows'),
    maxWorkerFailures: validPositiveInt(config.maxWorkerFailures, 'maxWorkerFailures'),
    windowsStarted: 0,
    workerInvocations: 0,
    workerFailures: 0,
    lastVerdict: null,
    phase: 'verifying',
    degradedReason: null,
    degradedAtMs: null,
  };
}

/**
 * Carries a still-live compatible transition budget, but never resurrects a
 * terminal degraded transition. A later concrete follower correction gets a
 * fresh bounded lifetime instead of silently inheriting permanent quarantine.
 */
export function carryOrCreateRobotContentTransitionBounds(
  previous: RobotContentTransitionBounds | null,
  nowMs: number,
  config: RobotContentTransitionBoundsConfig,
) {
  return previous?.phase === 'verifying'
    ? { ...previous }
    : createRobotContentTransitionBounds(nowMs, config);
}

function degradeRobotContentTransitionBounds(
  bounds: RobotContentTransitionBounds,
  reason: RobotContentTransitionDegradedReason,
  nowMs: number,
) {
  if (bounds.phase === 'degraded') return false;
  bounds.phase = 'degraded';
  bounds.degradedReason = reason;
  bounds.degradedAtMs = nowMs;
  return true;
}

export function sweepRobotContentTransitionBounds(
  bounds: RobotContentTransitionBounds,
  nowMs: number,
) {
  if (bounds.phase === 'degraded') return false;
  if (!Number.isFinite(nowMs) || nowMs < bounds.deadlineMs) return false;
  return degradeRobotContentTransitionBounds(bounds, 'deadline-exceeded', nowMs);
}

/**
 * Reserves one worker invocation. Compare work also consumes one independent
 * evidence window. Returning false means the transition is terminal/degraded;
 * callers must not start another worker and must not infer content authority.
 */
export function beginRobotContentTransitionWorker(
  bounds: RobotContentTransitionBounds,
  kind: 'anchor' | 'compare',
  nowMs: number,
) {
  if (bounds.phase === 'degraded') return false;
  if (sweepRobotContentTransitionBounds(bounds, nowMs)) return false;
  if (kind === 'compare' && bounds.windowsStarted >= bounds.maxWindows) {
    degradeRobotContentTransitionBounds(bounds, 'max-windows', nowMs);
    return false;
  }

  bounds.workerInvocations += 1;
  if (kind === 'compare') bounds.windowsStarted += 1;
  return true;
}

export function noteRobotContentTransitionVerdict(
  bounds: RobotContentTransitionBounds,
  verdict: RobotContentTransitionVerdict,
) {
  if (bounds.phase !== 'verifying') return false;
  bounds.lastVerdict = verdict;
  return true;
}

/**
 * Worker failure is evidence failure, never mapping evidence. Anchor failure is
 * terminal because there is no independent hypothesis anchor to retry. Compare
 * failures get a small bounded retry budget before terminal degradation.
 */
export function noteRobotContentTransitionWorkerFailure(
  bounds: RobotContentTransitionBounds,
  kind: 'anchor' | 'compare',
  nowMs: number,
) {
  if (bounds.phase === 'degraded') return false;
  bounds.workerFailures += 1;
  if (kind === 'anchor') {
    return degradeRobotContentTransitionBounds(bounds, 'anchor-worker-failure', nowMs);
  }
  if (bounds.workerFailures >= bounds.maxWorkerFailures) {
    return degradeRobotContentTransitionBounds(bounds, 'worker-failures', nowMs);
  }
  return sweepRobotContentTransitionBounds(bounds, nowMs);
}

export function robotContentTransitionBoundsStatus(
  bounds: RobotContentTransitionBounds,
  nowMs: number,
) {
  return {
    state: bounds.phase,
    startedAtMs: bounds.startedAtMs,
    deadlineMs: bounds.deadlineMs,
    ageMs: Math.max(0, Math.round(nowMs - bounds.startedAtMs)),
    deadlineRemainingMs: Math.max(0, Math.round(bounds.deadlineMs - nowMs)),
    windowsStarted: bounds.windowsStarted,
    maxWindows: bounds.maxWindows,
    workerInvocations: bounds.workerInvocations,
    workerFailures: bounds.workerFailures,
    maxWorkerFailures: bounds.maxWorkerFailures,
    lastVerdict: bounds.lastVerdict,
    degradedReason: bounds.degradedReason,
    degradedAtMs: bounds.degradedAtMs,
  };
}
