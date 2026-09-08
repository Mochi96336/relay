import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  evaluateRobotSemanticRecoveryDryRun,
  type RobotSemanticRecoveryAdapterResult,
  type RobotSemanticRecoveryExec,
} from './robot-semantic-recovery-adapter.js';
import {
  emptyRobotSemanticRecoveryState,
  parseRobotSemanticRecoveryState,
  type RobotSemanticRecoveryConfig,
  type RobotSemanticRecoveryState,
} from './robot-semantic-recovery-policy.js';

export const ROBOT_SEMANTIC_RECOVERY_DRY_RUN_STATE_BASENAME =
  'relay-robot-semantic-recovery-dry-run.json';

export function robotSemanticRecoveryDryRunStatePath(
  runtimeDirectory: string | undefined,
): string {
  const directory = runtimeDirectory?.trim();
  if (!directory) {
    throw new Error('XDG_RUNTIME_DIR is required for Robot semantic recovery dry-run state.');
  }
  if (!path.isAbsolute(directory)) {
    throw new Error('XDG_RUNTIME_DIR must be an absolute path.');
  }
  return path.join(directory, ROBOT_SEMANTIC_RECOVERY_DRY_RUN_STATE_BASENAME);
}

export async function readRobotSemanticRecoveryDryRunState(
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read Robot semantic recovery dry-run state ${stateFile}: ${message}`);
  }
}

export async function writeRobotSemanticRecoveryDryRunState(
  stateFile: string,
  state: RobotSemanticRecoveryState,
): Promise<void> {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, stateFile);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function runRobotSemanticRecoveryDryRunOnce(options: {
  stateFile: string;
  nowMs: number;
  port: number;
  requestTimeoutMs: number;
  config: RobotSemanticRecoveryConfig;
  fetchImpl?: typeof fetch;
  exec?: RobotSemanticRecoveryExec;
}): Promise<RobotSemanticRecoveryAdapterResult> {
  if (!Number.isFinite(options.nowMs) || !Number.isInteger(options.nowMs) || options.nowMs < 0) {
    throw new Error('Robot semantic recovery monotonic time must be a non-negative integer.');
  }

  const state = await readRobotSemanticRecoveryDryRunState(options.stateFile);
  const result = await evaluateRobotSemanticRecoveryDryRun(
    state,
    options.nowMs,
    options.config,
    {
      port: options.port,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchImpl: options.fetchImpl,
      exec: options.exec,
    },
  );
  const nextState = result.evidenceAvailable ? result.decision.state : result.state;

  // A dry-run restart candidate intentionally consumes the dry-run cooldown and
  // budget. This file is therefore permanently separate from any future live
  // recovery state; rehearsal must never mint or erase live restart authority.
  await writeRobotSemanticRecoveryDryRunState(options.stateFile, nextState);
  return result;
}
