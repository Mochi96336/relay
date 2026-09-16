import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { promisify } from 'node:util';

import { durableRename } from './file-durability.js';
import {
  clearRobotSemanticRecoveryFaultEvidence,
  fetchRobotSemanticRecoveryObservation,
  proveRobotBackingPcmProgress,
  readRobotRouteServiceActive,
  ROBOT_ROUTE_SERVICE,
  sampleRobotSemanticRecoveryEvidence,
  SYSTEMCTL,
  type RobotBackingPcmProgressResult,
  type RobotSemanticRecoveryEvidence,
  type RobotSemanticRecoveryExec,
  type RobotSemanticRecoveryObservationSnapshot,
} from './robot-semantic-recovery-adapter.js';
import {
  decideRobotSemanticRecovery,
  emptyRobotSemanticRecoveryState,
  parseRobotSemanticRecoveryState,
  type RobotSemanticRecoveryConfig,
  type RobotSemanticRecoveryResult,
  type RobotSemanticRecoveryState,
} from './robot-semantic-recovery-policy.js';

const execFileAsync = promisify(execFile) as RobotSemanticRecoveryExec;

export const ROBOT_SEMANTIC_RECOVERY_LIVE_STATE_BASENAME =
  'relay-robot-semantic-recovery-live.json';

export type RobotSemanticRecoverySleep = (delayMs: number) => Promise<void>;

export type RobotSemanticRecoveryVerificationResult = {
  recovered: boolean;
  cause: 'pcm-progressing' | 'route-inactive' | 'verification-timeout';
  proof: RobotBackingPcmProgressResult | null;
  samples: number;
  lastError: string | null;
};

export type RobotSemanticRecoveryLiveResult = {
  evidenceAvailable: boolean;
  evidence: RobotSemanticRecoveryEvidence | null;
  decision: RobotSemanticRecoveryResult | null;
  restartAttempted: boolean;
  recovered: boolean | null;
  verification: RobotSemanticRecoveryVerificationResult | null;
  error: Error | null;
  state: RobotSemanticRecoveryState;
};

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateLiveStateFile(runtimeDirectory: string | undefined): string {
  const directory = runtimeDirectory?.trim();
  if (!directory) {
    throw new Error('XDG_RUNTIME_DIR is required for Robot semantic live recovery state.');
  }
  if (!path.isAbsolute(directory)) {
    throw new Error('XDG_RUNTIME_DIR must be an absolute path.');
  }
  return path.join(directory, ROBOT_SEMANTIC_RECOVERY_LIVE_STATE_BASENAME);
}

export function robotSemanticRecoveryLiveStatePath(
  runtimeDirectory: string | undefined,
): string {
  return validateLiveStateFile(runtimeDirectory);
}

export async function readRobotSemanticRecoveryLiveState(
  stateFile: string,
): Promise<RobotSemanticRecoveryState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    const state = parseRobotSemanticRecoveryState(parsed);
    if (!state) {
      throw new Error('state payload does not match the semantic recovery state contract');
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRobotSemanticRecoveryState();
    }
    throw new Error(
      `could not read Robot semantic live recovery state ${stateFile}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Persist live recovery authority before any restart side effect.
 *
 * Atomic rename prevents a torn JSON file, but it is not a power-loss boundary
 * on Linux by itself. Sync the temporary file contents first, then use Relay's
 * durable rename primitive so the parent-directory entry is synced as well.
 */
export async function writeRobotSemanticRecoveryLiveState(
  stateFile: string,
  state: RobotSemanticRecoveryState,
): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await durableRename(temporary, stateFile);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function restartRobotRouteService(
  requestTimeoutMs: number,
  exec: RobotSemanticRecoveryExec = execFileAsync,
): Promise<void> {
  await exec(
    SYSTEMCTL,
    ['--user', 'restart', ROBOT_ROUTE_SERVICE],
    { timeout: requestTimeoutMs },
  );
}

/**
 * After one restart, require continuing Robot Backing PCM before calling the
 * recovery successful. A single reconnect packet, socket registration, or
 * active systemd unit is insufficient.
 *
 * Evidence gaps reset the two-snapshot proof. If systemd state itself cannot be
 * read, the iteration is blind and cannot contribute to a success proof. If the
 * route becomes inactive, verification exits immediately and never restarts it.
 */
export async function verifyRobotSemanticRecovery(options: {
  port: number;
  requestTimeoutMs: number;
  verificationTimeoutMs: number;
  sampleIntervalMs: number;
  fetchImpl?: typeof fetch;
  exec?: RobotSemanticRecoveryExec;
  now?: () => number;
  sleep?: RobotSemanticRecoverySleep;
}): Promise<RobotSemanticRecoveryVerificationResult> {
  if (!Number.isFinite(options.verificationTimeoutMs) || options.verificationTimeoutMs <= 0) {
    throw new Error('Robot recovery verification timeout must be positive.');
  }
  if (!Number.isFinite(options.sampleIntervalMs) || options.sampleIntervalMs <= 0) {
    throw new Error('Robot recovery verification sample interval must be positive.');
  }

  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let previous: RobotSemanticRecoveryObservationSnapshot | null = null;
  let lastProof: RobotBackingPcmProgressResult | null = null;
  let lastError: string | null = null;
  let samples = 0;

  while (now() - startedAt <= options.verificationTimeoutMs) {
    let routeServiceActive: boolean;
    try {
      routeServiceActive = await readRobotRouteServiceActive(
        options.requestTimeoutMs,
        options.exec,
      );
    } catch (error) {
      lastError = errorMessage(error);
      previous = null;
      const remainingMs = options.verificationTimeoutMs - (now() - startedAt);
      if (remainingMs <= 0) break;
      await sleep(Math.min(options.sampleIntervalMs, remainingMs));
      continue;
    }

    if (!routeServiceActive) {
      return {
        recovered: false,
        cause: 'route-inactive',
        proof: lastProof,
        samples,
        lastError,
      };
    }

    try {
      const current = await fetchRobotSemanticRecoveryObservation(
        options.port,
        options.requestTimeoutMs,
        options.fetchImpl,
      );
      samples += 1;
      lastError = null;
      if (previous !== null) {
        lastProof = proveRobotBackingPcmProgress(previous, current);
        if (lastProof.progressing) {
          return {
            recovered: true,
            cause: 'pcm-progressing',
            proof: lastProof,
            samples,
            lastError: null,
          };
        }
      }
      previous = current;
    } catch (error) {
      lastError = errorMessage(error);
      previous = null;
    }

    const remainingMs = options.verificationTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(Math.min(options.sampleIntervalMs, remainingMs));
  }

  return {
    recovered: false,
    cause: 'verification-timeout',
    proof: lastProof,
    samples,
    lastError,
  };
}

/**
 * Runs exactly one live recovery evaluation. At most one restart can occur.
 *
 * The restart budget/cooldown is committed durably before the side effect so a
 * crash, command timeout, or failed post-restart proof cannot mint a free retry.
 */
export async function runRobotSemanticRecoveryLiveOnce(options: {
  stateFile: string;
  nowMs: number;
  port: number;
  requestTimeoutMs: number;
  verificationTimeoutMs: number;
  verificationSampleIntervalMs: number;
  config: RobotSemanticRecoveryConfig;
  fetchImpl?: typeof fetch;
  exec?: RobotSemanticRecoveryExec;
  verificationNow?: () => number;
  sleep?: RobotSemanticRecoverySleep;
}): Promise<RobotSemanticRecoveryLiveResult> {
  if (!Number.isFinite(options.nowMs) || !Number.isInteger(options.nowMs) || options.nowMs < 0) {
    throw new Error('Robot semantic recovery monotonic time must be a non-negative integer.');
  }

  const state = await readRobotSemanticRecoveryLiveState(options.stateFile);
  let evidence: RobotSemanticRecoveryEvidence;
  try {
    evidence = await sampleRobotSemanticRecoveryEvidence({
      port: options.port,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchImpl: options.fetchImpl,
      exec: options.exec,
    });
  } catch (error) {
    const nextState = clearRobotSemanticRecoveryFaultEvidence(state);
    await writeRobotSemanticRecoveryLiveState(options.stateFile, nextState);
    return {
      evidenceAvailable: false,
      evidence: null,
      decision: null,
      restartAttempted: false,
      recovered: null,
      verification: null,
      error: error instanceof Error ? error : new Error(String(error)),
      state: nextState,
    };
  }

  let decision = decideRobotSemanticRecovery(
    state,
    evidence.observation,
    evidence.routeServiceActive,
    options.nowMs,
    options.config,
  );

  if (decision.action !== 'restart') {
    await writeRobotSemanticRecoveryLiveState(options.stateFile, decision.state);
    return {
      evidenceAvailable: true,
      evidence,
      decision,
      restartAttempted: false,
      recovered: null,
      verification: null,
      error: null,
      state: decision.state,
    };
  }

  // Close the operator-intent race between the policy sample and the effect.
  // If the route was manually stopped in that gap, re-evaluate as inactive so
  // no restart is issued and no restart budget is consumed.
  let stillActive: boolean;
  try {
    stillActive = await readRobotRouteServiceActive(options.requestTimeoutMs, options.exec);
  } catch (error) {
    const nextState = clearRobotSemanticRecoveryFaultEvidence(state);
    await writeRobotSemanticRecoveryLiveState(options.stateFile, nextState);
    return {
      evidenceAvailable: false,
      evidence: null,
      decision: null,
      restartAttempted: false,
      recovered: null,
      verification: null,
      error: error instanceof Error ? error : new Error(String(error)),
      state: nextState,
    };
  }

  if (!stillActive) {
    decision = decideRobotSemanticRecovery(
      state,
      evidence.observation,
      false,
      options.nowMs,
      options.config,
    );
    await writeRobotSemanticRecoveryLiveState(options.stateFile, decision.state);
    return {
      evidenceAvailable: true,
      evidence: { ...evidence, routeServiceActive: false },
      decision,
      restartAttempted: false,
      recovered: null,
      verification: null,
      error: null,
      state: decision.state,
    };
  }

  // Persist the consumed cooldown/budget before performing the effect. A failed
  // restart or a process crash after this point is still a real restart attempt.
  await writeRobotSemanticRecoveryLiveState(options.stateFile, decision.state);

  try {
    await restartRobotRouteService(options.requestTimeoutMs, options.exec);
  } catch (error) {
    return {
      evidenceAvailable: true,
      evidence,
      decision,
      restartAttempted: true,
      recovered: false,
      verification: null,
      error: error instanceof Error ? error : new Error(String(error)),
      state: decision.state,
    };
  }

  const verification = await verifyRobotSemanticRecovery({
    port: options.port,
    requestTimeoutMs: options.requestTimeoutMs,
    verificationTimeoutMs: options.verificationTimeoutMs,
    sampleIntervalMs: options.verificationSampleIntervalMs,
    fetchImpl: options.fetchImpl,
    exec: options.exec,
    now: options.verificationNow,
    sleep: options.sleep,
  });

  return {
    evidenceAvailable: true,
    evidence,
    decision,
    restartAttempted: true,
    recovered: verification.recovered,
    verification,
    error: null,
    state: decision.state,
  };
}
