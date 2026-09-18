import os from 'node:os';
import process from 'node:process';

import { envNumber } from './config.js';
import { ROBOT_ROUTE_SERVICE } from './robot-semantic-recovery-adapter.js';
import {
  robotSemanticRecoveryDryRunStatePath,
  runRobotSemanticRecoveryDryRunOnce,
} from './robot-semantic-recovery-dry-run.js';
import type { RobotSemanticRecoveryConfig } from './robot-semantic-recovery-policy.js';

const DRY_RUN_CONFIG: RobotSemanticRecoveryConfig = {
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
  const stateFile = robotSemanticRecoveryDryRunStatePath(process.env.XDG_RUNTIME_DIR);
  const nowMs = Math.round(os.uptime() * 1_000);
  const result = await runRobotSemanticRecoveryDryRunOnce({
    stateFile,
    nowMs,
    port,
    requestTimeoutMs,
    config: DRY_RUN_CONFIG,
  });

  if (result.evidenceAvailable) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      stateFile,
      nowMs,
      routeService: ROBOT_ROUTE_SERVICE,
      evidenceAvailable: true,
      routeServiceActive: result.evidence.routeServiceActive,
      action: result.decision.action,
      cause: result.decision.cause,
      faults: result.decision.faults,
      state: result.decision.state,
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    mode: 'dry-run',
    stateFile,
    nowMs,
    routeService: ROBOT_ROUTE_SERVICE,
    evidenceAvailable: false,
    error: result.error.message,
    state: result.state,
  }, null, 2)}\n`);
  process.exitCode = 2;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[robot-semantic-recovery-dry-run] fatal: ${message}\n`);
  process.exitCode = 1;
});
