import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  clearRobotFaultObservation,
  decideRobotRecovery,
  emptyRobotRecoveryState,
  parseRobotReadiness,
  parseRobotRecoveryState,
  type RobotRecoveryConfig,
  type RobotRecoveryState,
} from './robot-supervisor-policy.js';

const execFileAsync = promisify(execFile);

function envNumber(name: string, fallback: number, minimum: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number >= ${minimum}.`);
  }
  return value;
}

function envInteger(name: string, fallback: number, minimum: number) {
  const value = envNumber(name, fallback, minimum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

const PORT = envInteger('PORT', 3000, 1);
const POLL_MS = envNumber('RELAY_SUPERVISOR_POLL_MS', 5_000, 1_000);
const REQUEST_TIMEOUT_MS = envNumber('RELAY_SUPERVISOR_REQUEST_TIMEOUT_MS', 3_000, 250);
const DRY_RUN = process.env.RELAY_SUPERVISOR_DRY_RUN === '1';
const SYSTEMCTL = '/usr/bin/systemctl';
const ROUTE_SERVICE = 'relay-robot-source.service';
// Unlike source.html, readiness has no YouTube-origin requirement. Use the
// literal IPv4 loopback so Node fetch cannot choose ::1 while Relay listens on
// 0.0.0.0 only.
const READINESS_URL = process.env.RELAY_SUPERVISOR_READINESS_URL ?? `http://127.0.0.1:${PORT}/readyz`;
const CONFIG: RobotRecoveryConfig = {
  faultGraceMs: envNumber('RELAY_SUPERVISOR_FAULT_GRACE_MS', 30_000, 1_000),
  cooldownMs: envNumber('RELAY_SUPERVISOR_COOLDOWN_MS', 60_000, 1_000),
  budgetWindowMs: envNumber('RELAY_SUPERVISOR_BUDGET_WINDOW_MS', 10 * 60_000, 10_000),
  maxRestarts: envInteger('RELAY_SUPERVISOR_MAX_RESTARTS', 3, 1),
};

const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? '/tmp';
const STATE_FILE = path.join(
  runtimeDirectory,
  DRY_RUN ? 'relay-robot-supervisor-dry-run.json' : 'relay-robot-supervisor.json',
);

let stopped = false;
let lastNoticeKey = '';

function log(message: string) {
  process.stderr.write(`[robot-supervisor] ${message}\n`);
}

function notice(key: string, message: string) {
  if (key === lastNoticeKey) return;
  lastNoticeKey = key;
  log(message);
}

async function readState(): Promise<RobotRecoveryState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    const state = parseRobotRecoveryState(parsed);
    if (!state) throw new Error('state payload does not match the recovery-state contract');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRobotRecoveryState();
    // This file carries the retry budget. Corruption or an unreadable file must
    // not silently erase the safety limiter and grant a fresh set of restarts.
    throw new Error(`could not read recovery state ${STATE_FILE}: ${(error as Error).message}`);
  }
}

async function writeState(state: RobotRecoveryState) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_FILE);
}

async function readinessObservation() {
  const response = await fetch(READINESS_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`readiness returned HTTP ${response.status}`);
  }
  const observation = parseRobotReadiness(await response.json());
  if (!observation) throw new Error('readiness payload does not match the expected route contract');
  return observation;
}

async function routeServiceActive() {
  const { stdout } = await execFileAsync(
    SYSTEMCTL,
    ['--user', 'show', '--property=ActiveState', '--value', ROUTE_SERVICE],
    { timeout: REQUEST_TIMEOUT_MS },
  );
  const activeState = stdout.trim();
  if (!activeState) throw new Error(`could not determine ${ROUTE_SERVICE} ActiveState`);
  return activeState === 'active';
}

async function restartRobotRoute(faults: string[]) {
  const label = faults.join(', ');
  if (DRY_RUN) {
    log(`dry-run: would restart ${ROUTE_SERVICE} for ${label}`);
    return;
  }

  log(`restarting ${ROUTE_SERVICE} for ${label}`);
  try {
    await execFileAsync(SYSTEMCTL, ['--user', 'restart', ROUTE_SERVICE], { timeout: 20_000 });
  } catch (error) {
    log(`restart command failed: ${(error as Error).message}`);
  }
}

async function main() {
  let state = await readState();
  log(`watching ${READINESS_URL} every ${Math.round(POLL_MS)} ms${DRY_RUN ? ' · dry-run' : ''}`);

  while (!stopped) {
    try {
      const [observation, serviceActive] = await Promise.all([
        readinessObservation(),
        routeServiceActive(),
      ]);
      // Recovery state lives only for this boot, so use the host's monotonic
      // uptime clock. NTP or RTC corrections cannot erase retry history or
      // stretch a cooldown unexpectedly.
      const nowMs = Math.round(os.uptime() * 1_000);
      const result = decideRobotRecovery(state, observation, serviceActive, nowMs, CONFIG);
      state = result.state;
      await writeState(state);

      if (result.action === 'restart') {
        lastNoticeKey = '';
        await restartRobotRoute(result.faults);
      } else if (result.action === 'observe') {
        notice(
          `grace:${result.faults.join('|')}`,
          `Robot route fault observed; waiting ${Math.round(CONFIG.faultGraceMs / 1000)} s before recovery: ${result.faults.join(', ')}`,
        );
      } else if (result.action === 'exhausted') {
        notice(
          `exhausted:${result.faults.join('|')}`,
          `recovery budget exhausted (${CONFIG.maxRestarts} restarts / ${Math.round(CONFIG.budgetWindowMs / 60_000)} min); leaving fault still: ${result.faults.join(', ')}`,
        );
      } else if (result.cause === 'non-restartable') {
        notice(
          `manual:${result.faults.join('|')}`,
          `fault is outside automatic recovery policy; leaving it for diagnosis: ${result.faults.join(', ')}`,
        );
      } else if (result.cause === 'healthy') {
        notice('healthy', 'Robot route healthy.');
      } else if (result.cause === 'route-service-inactive') {
        notice('route-service-inactive', `${ROUTE_SERVICE} is not active; no semantic recovery action.`);
      }
    } catch (error) {
      // Missing Relay or an unreadable systemd state is not evidence that the
      // Robot route itself should be restarted. Break continuous-fault evidence
      // so a later good poll cannot inherit time spent blind.
      state = clearRobotFaultObservation(state);
      await writeState(state);
      notice('poll-error', `recovery evidence unavailable; no action: ${(error as Error).message}`);
    }

    if (!stopped) await sleep(POLL_MS);
  }
}

process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });

main().catch((error) => {
  log(`fatal: ${(error as Error).stack ?? (error as Error).message}`);
  process.exitCode = 1;
});
