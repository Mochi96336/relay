import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];

function executable(directory: string, name: string, source: string) {
  const filename = path.join(directory, name);
  writeFileSync(filename, `#!/usr/bin/env bash\nset -u\n${source}`);
  chmodSync(filename, 0o755);
}

function mockedEnvironment() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-robot-scripts-'));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, 'bin');
  const state = path.join(directory, 'state');
  mkdirSync(bin);
  mkdirSync(state);

  executable(bin, 'pactl', `
case "\${1:-}" in
  info) exit 0 ;;
  list)
    if [[ "\${2:-} \${3:-}" == "short sinks" ]]; then
      printf '1\\trelay_browser\\tmodule-null-sink.c\\ts16le 2ch 48000Hz\\tIDLE\\n'
      exit 0
    fi
    if [[ "\${2:-} \${3:-}" == "short sources" ]]; then
      if [[ "\${MOCK_MISSING_MONITOR:-0}" != 1 ]]; then
        printf '2\\trelay_browser.monitor\\tmodule-null-sink.c\\ts16le 2ch 48000Hz\\tIDLE\\n'
      fi
      exit 0
    fi
    ;;
  unload-module)
    printf '%s' "\${2:-}" >"$TEST_STATE/unloaded-module"
    exit 0
    ;;
esac
exit 1
`);

  executable(bin, 'parec', `
for argument in "$@"; do
  if [[ "$argument" == --rate=* ]]; then
    printf '%s' "\${argument#--rate=}" >"$TEST_STATE/parec-rate"
  fi
done
for _attempt in {1..100}; do
  [[ -f "$TEST_STATE/npm-ready" ]] && break
  sleep 0.01
done
printf '\\0\\0'
`);

  executable(bin, 'npm', `
printf '%s' "\${RELAY_BACKING_SAMPLE_RATE:-}" >"$TEST_STATE/npm-rate"
: >"$TEST_STATE/npm-ready"
dd of=/dev/null status=none
`);

  executable(bin, 'xvfb-run', `
printf '%s' "\${PULSE_SINK:-}" >"$TEST_STATE/browser-sink"
printf '%s\\n' "$@" >"$TEST_STATE/browser-arguments"
trap 'exit 0' TERM INT
while :; do sleep 1; done
`);

  executable(bin, 'chromium', 'exit 0\n');
  executable(bin, 'curl', `
printf '%s\\n' "$@" >>"$TEST_STATE/curl-arguments"
exit 0
`);
  executable(bin, 'pgrep', 'exit 1\n');

  return {
    state,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TEST_STATE: state,
    },
  };
}

function run(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [path.join(root, 'scripts', script)], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('robot-source launcher', () => {
  test('uses one sample rate, hides the key, and treats a child exit as failure', () => {
    const { env, state } = mockedEnvironment();
    const result = run('robot-source.sh', {
      ...env,
      PORT: '3100',
      RELAY_BACKING_SAMPLE_RATE: '44100',
      RELAY_KEY: 'do-not-print-this-key',
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(readFileSync(path.join(state, 'parec-rate'), 'utf8'), '44100');
    assert.equal(readFileSync(path.join(state, 'npm-rate'), 'utf8'), '44100');
    assert.doesNotMatch(result.stderr, /do-not-print-this-key/);
    assert.match(result.stderr, /localhost:3100\/source\.html\?robot=1/);
    assert.match(result.stderr, /authenticated/);
    assert.match(result.stderr, /component exited unexpectedly/);
  });

  test('rejects an invalid capture rate before starting the route', () => {
    const { env } = mockedEnvironment();
    const result = run('robot-source.sh', {
      ...env,
      RELAY_BACKING_SAMPLE_RATE: '44.1k',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /RELAY_BACKING_SAMPLE_RATE must be an integer/);
  });
});

describe('robot doctor', () => {
  test('checks the localhost route and an existing sink monitor without changing state', () => {
    const { env, state } = mockedEnvironment();
    const result = run('robot-doctor.sh', { ...env, PORT: '3100' });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /sink exists: relay_browser/);
    assert.match(result.stdout, /monitor exists: relay_browser\.monitor/);
    assert.match(result.stdout, /RESULT ready for robot:source/);

    const curlArguments = readFileSync(path.join(state, 'curl-arguments'), 'utf8');
    assert.match(curlArguments, /http:\/\/localhost:3100\/healthz/);
    assert.match(curlArguments, /http:\/\/localhost:3100\/source\.html\?robot=1/);
    assert.doesNotMatch(curlArguments, /127\.0\.0\.1/);
  });

  test('fails when a named sink has no monitor source', () => {
    const { env } = mockedEnvironment();
    const result = run('robot-doctor.sh', { ...env, MOCK_MISSING_MONITOR: '1' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /sink exists but monitor is missing/);
  });
});
