import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploy = path.join(root, 'deploy');
const unit = (name: string) => readFileSync(path.join(deploy, name), 'utf8');

function systemdVerifySkip() {
  if (spawnSync('systemd-analyze', ['--version']).error) return 'systemd-analyze unavailable';
  try {
    accessSync('/usr/bin/npm', constants.X_OK);
    accessSync('/usr/bin/systemctl', constants.X_OK);
  } catch {
    return 'deployment command unavailable on verifier host';
  }
  return false;
}

test('semantic recovery oneshot respects operator stop intent and owns no scheduler loop', () => {
  const service = unit('relay-robot-semantic-recovery.service');

  assert.match(service, /Type=oneshot/);
  assert.match(service, /WorkingDirectory=%h\/relay/);
  assert.match(service, /Environment=PORT=3100/);
  assert.match(service, /EnvironmentFile=-%h\/\.config\/relay\/robot\.env/);
  assert.match(
    service,
    /ExecCondition=\/usr\/bin\/systemctl --user --quiet is-active relay-server\.service/,
  );
  assert.match(
    service,
    /ExecCondition=\/usr\/bin\/systemctl --user --quiet is-active relay-robot-source\.service/,
  );
  assert.match(service, /ExecStart=\/usr\/bin\/npm run robot:recovery-live/);
  assert.match(service, /TimeoutStartSec=5min/);

  assert.doesNotMatch(service, /^(?:Requires|Wants)=/m,
    'recovery must not start an operator-stopped runtime unit');
  assert.doesNotMatch(service, /^Restart=/m,
    'semantic recovery is already budgeted by the live runner, not systemd respawn');
  assert.doesNotMatch(service, /systemctl[^\n]*\brestart\b/,
    'the audited live runner must remain the only restart-effect owner');
  assert.doesNotMatch(service, /\[Install\]/,
    'the oneshot is timer-triggered rather than enabled directly');
});

test('semantic recovery timer delays after activation and then waits for oneshot inactivity', () => {
  const timer = unit('relay-robot-semantic-recovery.timer');

  assert.match(timer, /OnActiveSec=45s/,
    'newly enabling recovery must always leave a stabilization window');
  assert.doesNotMatch(timer, /OnStartupSec=/,
    'a manager-relative deadline could already be expired when recovery is enabled later');
  assert.match(timer, /OnUnitInactiveSec=10s/);
  assert.doesNotMatch(timer, /OnUnitActiveSec=/,
    'a long verification must not bunch the next evaluation immediately after it');
  assert.match(timer, /AccuracySec=1s/);
  assert.match(timer, /Unit=relay-robot-semantic-recovery\.service/);
  assert.match(timer, /WantedBy=timers\.target/);
});

test('systemd accepts the semantic recovery oneshot and timer', { skip: systemdVerifySkip() }, () => {
  const result = spawnSync('systemd-analyze', [
    '--user',
    'verify',
    './relay-robot-semantic-recovery.service',
    './relay-robot-semantic-recovery.timer',
  ], { cwd: deploy, encoding: 'utf8' });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
