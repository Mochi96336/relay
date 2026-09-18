import os from 'node:os';
import process from 'node:process';

import { envNumber } from './config.js';
import { ROBOT_ROUTE_SERVICE } from './robot-semantic-recovery-adapter.js';
import {
  robotSemanticRecoveryLiveStatePath,
  runRobotSemanticRecoveryLiveOnce,
} from './robot-semantic-recovery-live.js';
import type { RobotSemanticRecoveryConfig } from './robot-semantic-recovery-policy.js';

const LIVE_CONFIG: RobotSemanticRecoveryConfig = {
  faultGraceMs: 30_000,
  cooldownMs: 60_000,
  budgetWindowMs: 10 * 60_000,
  maxRestarts: 3,
};

async function main() {
  const port = envNumber(process.env, 'PORT', 3100, {
    min: 1,
    max: 65_535,
    integer: true,
  });
  const requestTimeoutMs = envNumber(
    process.env,
    'RELAY_ROBOT_RECOVERY_REQUEST_TIMEOUT_MS',
    3_000,
    { min: 250, max: 30_000, integer: true },
  );
  const verificationTimeoutMs = envNumber(
    process.env,
    'RELAY_ROBOT_RECOVERY_VERIFICATION_TIMEOUT_MS',
    20_000,
    { min: 1_000, max: 120_000, integer: true },
  );
  const verificationSampleIntervalMs = envNumber(
    process.env,
    'RELAY_ROBOT_RECOVERY_VERIFICATION_SAMPLE_INTERVAL_MS',
    1_000,
    { min: 100, max: 10_000, integer: true },
  );
  if (verificationSampleIntervalMs > verificationTimeoutMs) {
    throw new Error('Robot recovery verification interval cannot exceed its timeout.');
  }

  const stateFile = robotSemanticRecoveryLiveStatePath(process.env.XDG_RUNTIME_DIR);
  const nowMs = Math.round(os.uptime() * 1_000);
  const result = await runRobotSemanticRecoveryLiveOnce({
    stateFile,
    nowMs,
    port,
    requestTimeoutMs,
    verificationTimeoutMs,
    verificationSampleIntervalMs,
    config: LIVE_CONFIG,
  });

  process.stdout.write(`${JSON.stringify({
    mode: 'live',
    stateFile,
    nowMs,
    routeService: ROBOT_ROUTE_SERVICE,
    evidenceAvailable: result.evidenceAvailable,
    routeServiceActive: result.evidence?.routeServiceActive ?? null,
    action: result.decision?.action ?? null,
    cause: result.decision?.cause ?? null,
    faults: result.decision?.faults ?? [],
    restartAttempted: result.restartAttempted,
    recovered: result.recovered,
    verification: result.verification,
    error: result.error?.message ?? null,
    state: result.state,
  }, null, 2)}\n`);

  if (!result.evidenceAvailable) {
    process.exitCode = 2;
  } else if (result.restartAttempted && result.recovered !== true) {
    process.exitCode = 3;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[robot-semantic-recovery-live] fatal: ${message}\n`);
  process.exitCode = 1;
});
