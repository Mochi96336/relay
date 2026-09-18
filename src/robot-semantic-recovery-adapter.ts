import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  decideRobotSemanticRecovery,
  type RobotSemanticRecoveryConfig,
  type RobotSemanticRecoveryObservation,
  type RobotSemanticRecoveryResult,
  type RobotSemanticRecoveryState,
} from './robot-semantic-recovery-policy.js';

export type RobotSemanticRecoveryExec = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as RobotSemanticRecoveryExec;

export const ROBOT_ROUTE_SERVICE = 'relay-robot-source.service';
export const SYSTEMCTL = '/usr/bin/systemctl';

/**
 * Recovery-decision fields plus the existing audio evidence needed to prove
 * that a restarted route is moving PCM rather than merely reconnecting.
 *
 * These extra fields do not grant restart authority. `decideRobotSemanticRecovery`
 * still consumes only the narrow RobotSemanticRecoveryObservation subset.
 */
export type RobotSemanticRecoveryObservationSnapshot = RobotSemanticRecoveryObservation & {
  workload: {
    uptimeMs: number;
  };
  sources: RobotSemanticRecoveryObservation['sources'] & {
    backing: RobotSemanticRecoveryObservation['sources']['backing'] & {
      frameAgeMs: number | null;
    };
  };
  mix: {
    backingStarvedFrames: number;
  };
};

export type RobotSemanticRecoveryEvidence = {
  routeServiceActive: boolean;
  observation: RobotSemanticRecoveryObservationSnapshot;
};

export type RobotSemanticRecoveryAdapterResult =
  | {
      evidenceAvailable: true;
      evidence: RobotSemanticRecoveryEvidence;
      decision: RobotSemanticRecoveryResult;
    }
  | {
      evidenceAvailable: false;
      error: Error;
      state: RobotSemanticRecoveryState;
    };

export type RobotBackingPcmProgressResult = {
  progressing: boolean;
  cause:
    | 'progressing'
    | 'source-not-ready'
    | 'observation-not-advancing'
    | 'missing-frame-evidence'
    | 'no-new-frame'
    | 'mixer-starved';
  previousFrameObservedAtMs: number | null;
  currentFrameObservedAtMs: number | null;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Parse only the status-v1 fields used by Robot recovery decisions and
 * post-restart PCM proof. Additive/unrelated v1 fields are intentionally ignored.
 */
export function parseRobotSemanticRecoveryObservationPayload(
  value: unknown,
): RobotSemanticRecoveryObservationSnapshot | null {
  const root = objectRecord(value);
  if (!root || root.schema !== 'relay.observation.v1') return null;

  const workload = objectRecord(root.workload);
  const sources = objectRecord(root.sources);
  const backing = objectRecord(sources?.backing);
  const robot = objectRecord(sources?.robot);
  const mix = objectRecord(root.mix);
  if (!workload || !sources || !backing || !robot || !mix) return null;

  const uptimeMs = workload.uptimeMs;
  const connected = backing.connected;
  const streaming = backing.streaming;
  const backingRobot = backing.robot;
  const frameAgeMs = backing.frameAgeMs;
  const sourceConnected = robot.sourceConnected;
  const backingStarvedFrames = mix.backingStarvedFrames;
  if (
    !finiteNonNegative(uptimeMs)
    || typeof connected !== 'boolean'
    || typeof streaming !== 'boolean'
    || typeof backingRobot !== 'boolean'
    || (frameAgeMs !== null && !finiteNonNegative(frameAgeMs))
    || typeof sourceConnected !== 'boolean'
    || !Number.isInteger(backingStarvedFrames)
    || Number(backingStarvedFrames) < 0
  ) return null;

  return {
    workload: {
      uptimeMs,
    },
    sources: {
      backing: {
        connected,
        streaming,
        robot: backingRobot,
        frameAgeMs: frameAgeMs as number | null,
      },
      robot: {
        sourceConnected,
      },
    },
    mix: {
      backingStarvedFrames: Number(backingStarvedFrames),
    },
  };
}

function robotBackingSourceReady(observation: RobotSemanticRecoveryObservationSnapshot) {
  return observation.sources.backing.connected
    && observation.sources.backing.streaming
    && observation.sources.backing.robot
    && observation.sources.robot.sourceConnected;
}

function backingFrameObservedAtMs(
  observation: RobotSemanticRecoveryObservationSnapshot,
): number | null {
  const frameAgeMs = observation.sources.backing.frameAgeMs;
  if (frameAgeMs === null) return null;
  return observation.workload.uptimeMs - frameAgeMs;
}

/**
 * Proves continued post-restart PCM progress from two authoritative snapshots.
 *
 * `connected`/`streaming` alone can become true after a socket or process comes
 * back while audio immediately stalls again. A successful proof therefore needs
 * a later Backing frame timestamp and no newly accumulated mixer starvation.
 * Both the observation clock and frame age come from Relay's monotonic runtime,
 * so NTP/wall-clock corrections cannot mint fake PCM progress. A Relay restart
 * resets uptime and deliberately invalidates the comparison.
 */
export function proveRobotBackingPcmProgress(
  previous: RobotSemanticRecoveryObservationSnapshot,
  current: RobotSemanticRecoveryObservationSnapshot,
): RobotBackingPcmProgressResult {
  const previousFrameObservedAtMs = backingFrameObservedAtMs(previous);
  const currentFrameObservedAtMs = backingFrameObservedAtMs(current);
  const base = { previousFrameObservedAtMs, currentFrameObservedAtMs };

  if (!robotBackingSourceReady(previous) || !robotBackingSourceReady(current)) {
    return { progressing: false, cause: 'source-not-ready', ...base };
  }

  if (current.workload.uptimeMs <= previous.workload.uptimeMs) {
    return { progressing: false, cause: 'observation-not-advancing', ...base };
  }

  if (previousFrameObservedAtMs === null || currentFrameObservedAtMs === null) {
    return { progressing: false, cause: 'missing-frame-evidence', ...base };
  }

  if (currentFrameObservedAtMs <= previousFrameObservedAtMs) {
    return { progressing: false, cause: 'no-new-frame', ...base };
  }

  if (current.mix.backingStarvedFrames > previous.mix.backingStarvedFrames) {
    return { progressing: false, cause: 'mixer-starved', ...base };
  }

  return { progressing: true, cause: 'progressing', ...base };
}

export function clearRobotSemanticRecoveryFaultEvidence(
  state: RobotSemanticRecoveryState,
): RobotSemanticRecoveryState {
  return {
    ...state,
    faultKey: null,
    faultSinceMs: null,
  };
}

export function robotSemanticRecoveryObservationUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Relay observation port must be an integer from 1 to 65535.');
  }
  return `http://127.0.0.1:${port}/api/status/v1`;
}

export async function fetchRobotSemanticRecoveryObservation(
  port: number,
  requestTimeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RobotSemanticRecoveryObservationSnapshot> {
  const response = await fetchImpl(robotSemanticRecoveryObservationUrl(port), {
    cache: 'no-store',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status !== 200) {
    throw new Error(`observation endpoint returned HTTP ${response.status}`);
  }
  const observation = parseRobotSemanticRecoveryObservationPayload(await response.json());
  if (!observation) {
    throw new Error('observation payload does not match relay.observation.v1 recovery fields');
  }
  return observation;
}

export async function readRobotRouteServiceActive(
  requestTimeoutMs: number,
  exec: RobotSemanticRecoveryExec = execFileAsync,
): Promise<boolean> {
  const { stdout } = await exec(
    SYSTEMCTL,
    ['--user', 'show', '--property=ActiveState', '--value', ROBOT_ROUTE_SERVICE],
    { timeout: requestTimeoutMs },
  );
  const activeState = stdout.trim();
  if (!activeState) throw new Error(`could not determine ${ROBOT_ROUTE_SERVICE} ActiveState`);
  return activeState === 'active';
}

export async function sampleRobotSemanticRecoveryEvidence(options: {
  port: number;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
  exec?: RobotSemanticRecoveryExec;
}): Promise<RobotSemanticRecoveryEvidence> {
  const [observation, routeServiceActive] = await Promise.all([
    fetchRobotSemanticRecoveryObservation(
      options.port,
      options.requestTimeoutMs,
      options.fetchImpl,
    ),
    readRobotRouteServiceActive(options.requestTimeoutMs, options.exec),
  ]);
  return { observation, routeServiceActive };
}

/**
 * One read-only semantic-recovery evaluation. It never performs a restart.
 * Evidence failures clear only continuous-fault timing, preserving cooldown and
 * restart-budget history so blindness can never earn recovery authority.
 */
export async function evaluateRobotSemanticRecoveryDryRun(
  state: RobotSemanticRecoveryState,
  nowMs: number,
  config: RobotSemanticRecoveryConfig,
  options: {
    port: number;
    requestTimeoutMs: number;
    fetchImpl?: typeof fetch;
    exec?: RobotSemanticRecoveryExec;
  },
): Promise<RobotSemanticRecoveryAdapterResult> {
  try {
    const evidence = await sampleRobotSemanticRecoveryEvidence(options);
    return {
      evidenceAvailable: true,
      evidence,
      decision: decideRobotSemanticRecovery(
        state,
        evidence.observation,
        evidence.routeServiceActive,
        nowMs,
        config,
      ),
    };
  } catch (error) {
    return {
      evidenceAvailable: false,
      error: error instanceof Error ? error : new Error(String(error)),
      state: clearRobotSemanticRecoveryFaultEvidence(state),
    };
  }
}
