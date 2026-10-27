import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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

  // Stands in for the node that runs the entry; records the arguments it got.
  // esbuild's launcher is itself a node script, so that one goes to real node.
  executable(bin, 'node', `
if [[ "\${1:-}" == */esbuild ]]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
printf '%s\\n' "$*" >>"$TEST_STATE/node-calls"
: >"$TEST_STATE/entered"
while [[ ! -f "$TEST_STATE/release" ]]; do
  sleep 0.02
done
`);

  return {
    state,
    runtime,
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
  assert.equal(existsSync(path.join(state, 'node-calls')), false, 'recovery body must not start');
});

// The wrapper holds its lock with `flock` and exits before the recovery body
// without it; Git Bash on Windows has none.
function flockSkip() {
  const probe = spawnSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8' });
  return probe.status === 0 ? false : 'flock unavailable';
}

test('a second live recovery process skips while the first still owns restart authority', { skip: flockSkip() }, async () => {
  const { env, state } = harness();
  const entered = path.join(state, 'entered');
  const release = path.join(state, 'release');
  const calls = path.join(state, 'node-calls');
  const first = spawn('bash', [wrapper], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstExit = once(first, 'exit');
  let firstStderr = '';
  first.stderr?.on('data', (chunk) => { firstStderr += String(chunk); });

  try {
    // The first run may build the bundle before it enters the body.
    await waitForFile(entered, 15_000);

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
    const entries = readFileSync(calls, 'utf8').trim().split(/\r?\n/);
    assert.equal(entries.length, 1, 'only one process may enter the live recovery body');
    assert.match(entries[0], /\/relay-robot-semantic-recovery-live\.[0-9a-f]{16}\.mjs$/);

    writeFileSync(release, 'release\n');
    const [code, signal] = await firstExit;
    assert.equal(signal, null, `first recovery was signalled; stderr:\n${firstStderr}`);
    assert.equal(code, 0, `first recovery failed; stderr:\n${firstStderr}`);
  } finally {
    await stopChild(first, release);
  }
});

/**
 * A stand-in checkout holding only what the wrapper reads: itself, src/, the
 * lockfile, tsconfig.json and, when `withEsbuild`, the real node_modules.
 */
function fakeCheckout(withEsbuild: boolean) {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'relay-recovery-checkout-'));
  temporaryDirectories.push(checkout);
  mkdirSync(path.join(checkout, 'scripts'));
  mkdirSync(path.join(checkout, 'src'));
  copyFileSync(wrapper, path.join(checkout, 'scripts', 'robot-semantic-recovery-live.sh'));
  writeFileSync(path.join(checkout, 'package-lock.json'), '{}\n');
  writeFileSync(path.join(checkout, 'tsconfig.json'), '{}\n');
  writeFileSync(path.join(checkout, 'src', 'robot-semantic-recovery-live-entry.ts'), "console.log('first');\n");
  if (withEsbuild) symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
  return checkout;
}

function runFakeCheckout(checkout: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync('bash', [path.join(checkout, 'scripts', 'robot-semantic-recovery-live.sh')], {
    cwd: os.tmpdir(),
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  return result;
}

test('live recovery runs a bundle keyed by its sources and rebuilds it when they change', { skip: flockSkip() }, () => {
  const { env, state, runtime } = harness();
  writeFileSync(path.join(state, 'release'), 'release\n');
  const checkout = fakeCheckout(true);
  const bundles = () => readdirSync(runtime).filter((name) => name.endsWith('.mjs'));
  const lastCall = () => readFileSync(path.join(state, 'node-calls'), 'utf8').trim().split(/\r?\n/).at(-1);

  runFakeCheckout(checkout, env);
  const [first] = bundles();
  assert.match(first, /^relay-robot-semantic-recovery-live\.[0-9a-f]{16}\.mjs$/);
  assert.equal(lastCall(), path.join(runtime, first));
  assert.match(readFileSync(path.join(runtime, first), 'utf8'), /first/);

  runFakeCheckout(checkout, env);
  assert.deepEqual(bundles(), [first], 'unchanged sources reuse the bundle');

  writeFileSync(path.join(checkout, 'src', 'robot-semantic-recovery-live-entry.ts'), "console.log('second');\n");
  runFakeCheckout(checkout, env);
  const [second] = bundles();
  assert.notEqual(second, first);
  assert.deepEqual(bundles(), [second], 'the stale bundle is removed');
  assert.match(readFileSync(path.join(runtime, second), 'utf8'), /second/);
  assert.equal(lastCall(), path.join(runtime, second));

  // esbuild reads tsconfig.json, so it is part of what the bundle is keyed by.
  writeFileSync(path.join(checkout, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
  runFakeCheckout(checkout, env);
  const [third] = bundles();
  assert.notEqual(third, second);
  assert.equal(lastCall(), path.join(runtime, third));
});

test('live recovery still runs, through tsx, when it cannot hash its sources', { skip: flockSkip() }, () => {
  const { env, state, runtime } = harness();
  writeFileSync(path.join(state, 'release'), 'release\n');
  const checkout = fakeCheckout(true);
  rmSync(path.join(checkout, 'package-lock.json'));
  const result = runFakeCheckout(checkout, env);

  assert.match(result.stderr, /could not hash the sources of src\/robot-semantic-recovery-live-entry\.ts; running it through tsx/);
  assert.equal(readFileSync(path.join(state, 'node-calls'), 'utf8').trim(),
    '--import tsx src/robot-semantic-recovery-live-entry.ts');
  assert.deepEqual(readdirSync(runtime).filter((name) => name.includes('.mjs')), []);
});

test('live recovery falls back to tsx when it cannot build the bundle', { skip: flockSkip() }, () => {
  const { env, state, runtime } = harness();
  writeFileSync(path.join(state, 'release'), 'release\n');
  const result = runFakeCheckout(fakeCheckout(false), env);

  assert.match(result.stderr, /could not bundle src\/robot-semantic-recovery-live-entry\.ts; running it through tsx/);
  assert.equal(readFileSync(path.join(state, 'node-calls'), 'utf8').trim(),
    '--import tsx src/robot-semantic-recovery-live-entry.ts');
  assert.deepEqual(readdirSync(runtime).filter((name) => name.includes('.mjs')), []);
});
