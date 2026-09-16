import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = path.join(root, 'scripts', 'robot-semantic-recovery-live.sh');
const temporaryDirectories: string[] = [];

function executable(directory: string, name: string, source: string) {
  const filename = path.join(directory, name);
  writeFileSync(filename, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${source}`);
  chmodSync(filename, 0o755);
}

function harness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-recovery-lock-'));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const state = path.join(directory, 'state');
  mkdirSync(bin);
  mkdirSync(runtime);
  mkdirSync(state);

  executable(bin, 'tsx', `
printf 'run\\n' >>"$TEST_STATE/tsx-calls"
: >"$TEST_STATE/entered"
while [[ ! -f "$TEST_STATE/release" ]]; do
  sleep 0.02
done
`);

  return {
    state,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TEST_STATE: state,
      XDG_RUNTIME_DIR: runtime,
    },
  };
}

async function waitForFile(filename: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filename)) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${filename}`);
}

async function stopChild(child: ChildProcess, release: string) {
  if (!existsSync(release)) writeFileSync(release, 'release\n');
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    delay(1_000).then(() => false),
  ]);
  if (!exited) child.kill('SIGKILL');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

test('the production live npm command always passes through the single-instance wrapper', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.['robot:recovery-live'],
    'bash scripts/robot-semantic-recovery-live.sh',
  );
});

test('live recovery fails closed without an absolute per-user runtime directory', () => {
  const { env, state } = harness();
  const result = spawnSync('bash', [wrapper], {
    cwd: root,
    env: { ...env, XDG_RUNTIME_DIR: '' },
    encoding: 'utf8',
    timeout: 2_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /XDG_RUNTIME_DIR must be an absolute path/);
  assert.equal(existsSync(path.join(state, 'tsx-calls')), false, 'recovery body must not start');
});

test('a second live recovery process skips while the first still owns restart authority', async () => {
  const { env, state } = harness();
  const entered = path.join(state, 'entered');
  const release = path.join(state, 'release');
  const calls = path.join(state, 'tsx-calls');
  const first = spawn('bash', [wrapper], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstExit = once(first, 'exit');
  let firstStderr = '';
  first.stderr?.on('data', (chunk) => { firstStderr += String(chunk); });

  try {
    await waitForFile(entered);

    const second = spawnSync('bash', [wrapper], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 2_000,
    });
    assert.ifError(second.error);
    assert.equal(second.status, 0, `stderr:\n${second.stderr}`);
    assert.deepEqual(JSON.parse(second.stdout.trim()), {
      mode: 'live',
      skipped: 'already-running',
      restartAttempted: false,
    });
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split(/\r?\n/), ['run'],
      'only one process may enter the live recovery body');

    writeFileSync(release, 'release\n');
    const [code, signal] = await firstExit;
    assert.equal(signal, null, `first recovery was signalled; stderr:\n${firstStderr}`);
    assert.equal(code, 0, `first recovery failed; stderr:\n${firstStderr}`);
  } finally {
    await stopChild(first, release);
  }
});
