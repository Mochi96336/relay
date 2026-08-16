import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decideRobotRecovery,
  emptyRobotRecoveryState,
  parseRobotReadiness,
  parseRobotRecoveryState,
  type RobotReadinessObservation,
  type RobotRecoveryConfig,
  type RobotRecoveryState,
} from '../src/robot-supervisor-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config: RobotRecoveryConfig = {
  faultGraceMs: 30_000,
  cooldownMs: 60_000,
  budgetWindowMs: 10 * 60_000,
  maxRestarts: 3,
};

function decide(
  state: RobotRecoveryState,
  nowMs: number,
  routeMode: 'idle' | 'song' | 'legacy' | 'robot',
  reasons: string[],
  options: {
    routeServiceActive?: boolean;
    backing?: Partial<RobotReadinessObservation['backing']>;
    robotSourceConnected?: boolean;
  } = {},
) {
  const observation: RobotReadinessObservation = {
    routeMode,
    reasons,
    backing: {
      connected: true,
      streaming: true,
      robot: true,
      ...options.backing,
    },
    robotSourceConnected: options.robotSourceConnected ?? true,
  };
  return decideRobotRecovery(
    state,
    observation,
    options.routeServiceActive ?? true,
    nowMs,
    config,
  );
}

test('readiness parser consumes route evidence but not phone/session reasons', () => {
  const observation = parseRobotReadiness({
    ready: true,
    reasons: [],
    sessionReasons: ['mic-not-streaming', 'phone-timeline-not-connected'],
    components: {
      route: { mode: 'robot' },
      backing: { connected: true, streaming: true, robot: true },
      robotSource: { connected: true },
    },
  });

  assert.deepEqual(observation, {
    routeMode: 'robot',
    reasons: [],
    backing: { connected: true, streaming: true, robot: true },
    robotSourceConnected: true,
  });
  assert.equal(
    decideRobotRecovery(emptyRobotRecoveryState(), observation!, true, 0, config).action,
    'none',
  );
});

test('readiness parser fails closed when route component evidence is incomplete', () => {
  assert.equal(parseRobotReadiness({
    reasons: [],
    components: {
      route: { mode: 'robot' },
      backing: { connected: true, streaming: true },
      robotSource: { connected: true },
    },
  }), null);
});

test('persisted recovery state must match the complete safety contract', () => {
  assert.deepEqual(parseRobotRecoveryState({
    faultKey: 'backing-not-streaming',
    faultSinceMs: 12_000,
    cooldownUntilMs: 90_000,
    restartHistoryMs: [30_000, 60_000],
  }), {
    faultKey: 'backing-not-streaming',
    faultSinceMs: 12_000,
    cooldownUntilMs: 90_000,
    restartHistoryMs: [30_000, 60_000],
  });

  for (const malformed of [
    {},
    { faultKey: null, faultSinceMs: null, cooldownUntilMs: 0 },
    { faultKey: 1, faultSinceMs: null, cooldownUntilMs: 0, restartHistoryMs: [] },
    { faultKey: null, faultSinceMs: 'now', cooldownUntilMs: 0, restartHistoryMs: [] },
    { faultKey: null, faultSinceMs: null, cooldownUntilMs: 'later', restartHistoryMs: [] },
    { faultKey: null, faultSinceMs: null, cooldownUntilMs: 0, restartHistoryMs: ['recent'] },
  ]) {
    assert.equal(parseRobotRecoveryState(malformed), null);
  }
});

test('a transient Robot route fault never reaches restart authority', () => {
  let state = emptyRobotRecoveryState();
  let result = decide(state, 0, 'robot', ['backing-not-streaming']);
  state = result.state;
  assert.equal(result.action, 'observe');

  result = decide(state, 29_999, 'robot', ['backing-not-streaming']);
  state = result.state;
  assert.equal(result.action, 'observe');

  result = decide(state, 30_000, 'robot', []);
  assert.equal(result.action, 'none');
  assert.equal(result.cause, 'healthy');
  assert.deepEqual(result.state.restartHistoryMs, []);
});

test('a persistent allowlisted Robot route fault restarts only after grace', () => {
  let state = emptyRobotRecoveryState();
  let result = decide(state, 1_000, 'robot', ['robot-source-not-connected']);
  state = result.state;
  assert.equal(result.action, 'observe');

  result = decide(state, 31_000, 'robot', ['robot-source-not-connected']);
  assert.equal(result.action, 'restart');
  assert.deepEqual(result.state.restartHistoryMs, [31_000]);
  assert.equal(result.state.cooldownUntilMs, 91_000);
});

test('cooldown prevents restart loops and requires a fresh grace window afterwards', () => {
  let state = emptyRobotRecoveryState();
  state = decide(state, 0, 'robot', ['backing-not-connected']).state;
  let result = decide(state, 30_000, 'robot', ['backing-not-connected']);
  state = result.state;
  assert.equal(result.action, 'restart');

  result = decide(state, 60_000, 'robot', ['backing-not-connected']);
  state = result.state;
  assert.equal(result.action, 'none');
  assert.equal(result.cause, 'cooldown');

  result = decide(state, 90_000, 'robot', ['backing-not-connected']);
  state = result.state;
  assert.equal(result.action, 'observe');

  result = decide(state, 120_000, 'robot', ['backing-not-connected']);
  assert.equal(result.action, 'restart');
  assert.deepEqual(result.state.restartHistoryMs, [30_000, 120_000]);
});

test('unknown or explicitly non-restartable readiness reasons fail closed', () => {
  const manual = decide(emptyRobotRecoveryState(), 0, 'robot', ['backing-not-robot']);
  assert.equal(manual.action, 'none');
  assert.equal(manual.cause, 'non-restartable');

  const future = decide(emptyRobotRecoveryState(), 0, 'robot', ['future-new-fault']);
  assert.equal(future.action, 'none');
  assert.equal(future.cause, 'non-restartable');
});

test('an inactive route service is operator intent and never gains implicit start authority', () => {
  const result = decide(
    emptyRobotRecoveryState(),
    0,
    'robot',
    ['backing-not-streaming'],
    { routeServiceActive: false },
  );
  assert.equal(result.action, 'none');
  assert.equal(result.cause, 'route-service-inactive');
  assert.deepEqual(result.faults, []);
});

test('an active Robot service can recover when Relay has forgotten the whole route while idle', () => {
  const missingRoute = {
    backing: { connected: false, streaming: false, robot: false },
    robotSourceConnected: false,
  };
  let state = emptyRobotRecoveryState();
  let result = decide(state, 0, 'idle', [], missingRoute);
  state = result.state;
  assert.equal(result.action, 'observe');
  assert.deepEqual(result.faults, ['backing-not-connected', 'robot-source-not-connected']);

  result = decide(state, 30_000, 'idle', [], missingRoute);
  assert.equal(result.action, 'restart');
});

test('an active Robot service does not stomp an explicit non-Robot backing route', () => {
  const result = decide(
    emptyRobotRecoveryState(),
    0,
    'legacy',
    [],
    {
      backing: { connected: true, streaming: true, robot: false },
      robotSourceConnected: false,
    },
  );
  assert.equal(result.action, 'none');
  assert.equal(result.cause, 'non-restartable');
  assert.ok(result.faults.includes('backing-not-robot'));
});

test('recovery stops after the retry budget is exhausted', () => {
  const state: RobotRecoveryState = {
    faultKey: 'backing-not-streaming',
    faultSinceMs: 10_000,
    cooldownUntilMs: 0,
    restartHistoryMs: [1_000, 2_000, 3_000],
  };

  const result = decide(state, 40_000, 'robot', ['backing-not-streaming']);
  assert.equal(result.action, 'exhausted');
  assert.equal(result.cause, 'budget-exhausted');
  assert.equal(result.state.restartHistoryMs.length, 3);
});

test('expired restart history stops consuming the recovery budget', () => {
  const state: RobotRecoveryState = {
    faultKey: 'backing-not-streaming',
    faultSinceMs: 600_000,
    cooldownUntilMs: 0,
    restartHistoryMs: [1_000, 2_000, 3_000],
  };

  const result = decide(state, 700_000, 'robot', ['backing-not-streaming']);
  assert.equal(result.action, 'restart');
  assert.deepEqual(result.state.restartHistoryMs, [700_000]);
});

test('runtime pins authority, boot-scoped state, monotonic time, and IPv4 loopback', () => {
  const source = readFileSync(path.join(root, 'src', 'robot-supervisor.ts'), 'utf8');
  assert.match(source, /const SYSTEMCTL = '\/usr\/bin\/systemctl';/);
  assert.match(source, /const ROUTE_SERVICE = 'relay-robot-source\.service';/);
  assert.doesNotMatch(source, /RELAY_SUPERVISOR_SYSTEMCTL/);
  assert.doesNotMatch(source, /RELAY_SUPERVISOR_ROUTE_SERVICE/);
  assert.doesNotMatch(source, /RELAY_SUPERVISOR_STATE_FILE/);
  assert.match(source, /http:\/\/127\.0\.0\.1:\$\{PORT\}\/readyz/);
  assert.match(source, /--property=ActiveState/);
  assert.match(source, /os\.uptime\(\) \* 1_000/);
  assert.doesNotMatch(source, /Date\.now\(\)/);
  assert.match(source, /parseRobotRecoveryState/);
  assert.match(source, /could not read recovery state/);
});

test('supervisor unit is narrow, restartable, and ordered after the route when both are started', () => {
  const unit = readFileSync(path.join(root, 'deploy', 'relay-robot-supervisor.service'), 'utf8');
  assert.match(unit, /ExecStart=\/usr\/bin\/npm run robot:supervisor/);
  assert.match(unit, /Wants=relay-server\.service/);
  assert.match(unit, /After=relay-server\.service relay-robot-source\.service/);
  assert.doesNotMatch(unit, /Requires=relay-robot-source\.service/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /StartLimitBurst=/);
  assert.doesNotMatch(unit, /RELAY_KEY=/);
});

function systemdVerifySkip() {
  if (spawnSync('systemd-analyze', ['--version']).error) return 'systemd-analyze unavailable';
  try {
    accessSync('/usr/bin/npm', constants.X_OK);
  } catch {
    return '/usr/bin/npm unavailable on verifier host';
  }
  return false;
}

test('systemd accepts the supervisor unit', { skip: systemdVerifySkip() }, () => {
  const result = spawnSync('systemd-analyze', [
    '--user',
    'verify',
    './relay-robot-supervisor.service',
  ], { cwd: path.join(root, 'deploy'), encoding: 'utf8' });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
