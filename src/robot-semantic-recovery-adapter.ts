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

export type RobotSemanticRecoveryEvidence = {
  routeServiceActive: boolean;
  observation: RobotSemanticRecoveryObservation;
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse only the status-v1 fields that are allowed to influence automatic Robot
 * restart authority. Additive/unrelated v1 fields are intentionally ignored.
 */
export function parseRobotSemanticRecoveryObservationPayload(
  value: unknown,
): RobotSemanticRecoveryObservation | null {
  const root = objectRecord(value);
  if (!root || root.schema !== 'relay.observation.v1') return null;
  const sources = objectRecord(root.sources);
  const backing = objectRecord(sources?.backing);
  const robot = objectRecord(sources?.robot);
  if (!sources || !backing || !robot) return null;

  const connected = backing.connected;
  const streaming = backing.streaming;
  const backingRobot = backing.robot;
  const sourceConnected = robot.sourceConnected;
  if (
    typeof connected !== 'boolean'
    || typeof streaming !== 'boolean'
    || typeof backingRobot !== 'boolean'
    || typeof sourceConnected !== 'boolean'
  ) return null;

  return {
    sources: {
      backing: {
        connected,
        streaming,
        robot: backingRobot,
      },
      robot: {
        sourceConnected,
      },
    },
  };
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
): Promise<RobotSemanticRecoveryObservation> {
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
