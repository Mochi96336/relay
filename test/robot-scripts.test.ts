import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if [[ "$argument" == --latency-msec=* ]]; then
    printf '%s' "\${argument#--latency-msec=}" >"$TEST_STATE/parec-latency"
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
      // The launcher takes a per-sink `flock` in `XDG_RUNTIME_DIR`. Pointed at
      // the real one, this test cannot run on a host where the robot route is
      // actually live: the launcher would exit on the lock instead of starting
      // the mocked route, and its failure exit status is the same 1 the test
      // expects from a child exiting. Give each run its own lock directory.
      XDG_RUNTIME_DIR: directory,
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

function systemdVerifySkip() {
  if (spawnSync('systemd-analyze', ['--version']).error) return 'systemd-analyze unavailable';
  try {
    accessSync('/usr/bin/npm', constants.X_OK);
  } catch {
    return '/usr/bin/npm unavailable on verifier host';
  }
  return false;
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
      RELAY_BACKING_CAPTURE_LATENCY_MS: '60',
      RELAY_KEY: 'do-not-print-this-key',
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(readFileSync(path.join(state, 'parec-rate'), 'utf8'), '44100');
    assert.equal(readFileSync(path.join(state, 'parec-latency'), 'utf8'), '60');
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

  test('rejects an invalid capture latency before starting the route', () => {
    const { env } = mockedEnvironment();
    const result = run('robot-source.sh', {
      ...env,
      RELAY_BACKING_CAPTURE_LATENCY_MS: '2 seconds',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /RELAY_BACKING_CAPTURE_LATENCY_MS must be an integer/);
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

describe('unattended boot', () => {
  const unit = (name: string) => readFileSync(path.join(root, 'deploy', name), 'utf8');

  /**
   * The robot page is opened once, by a launcher, on a machine that may reach
   * Chromium before it reaches the network. A script tag that failed is never
   * retried by the browser, and nobody is there to reload the page.
   */
  test('the robot source page keeps asking for the YouTube API', () => {
    const source = readFileSync(path.join(root, 'public', 'source.js'), 'utf8');

    assert.match(source, /setInterval\(/, 'a one-shot script injection cannot survive a boot with no network');
    assert.ok(
      source.indexOf('function loadYouTubeApi') < source.indexOf('iframe_api'),
      'the API script must be injected from a function that can be called again',
    );
    assert.match(source, /if \(window\.YT\?\.Player\) return;/);
    assert.match(source, /clearInterval\(apiRetryTimer\)/, 'retrying must stop once a player exists');
  });

  test('the route unit waits for the server to answer before opening the page', () => {
    const route = unit('relay-robot-source.service');

    assert.match(route, /ExecStartPre=.*curl.*\/healthz/, 'After= orders the start but does not wait for the port');
    assert.match(route, /--retry 30/);
    assert.match(route, /Requires=relay-server\.service/);
    assert.match(route, /After=relay-server\.service/);
  });

  test('both units restart on failure without thrashing', () => {
    for (const name of ['relay-server.service', 'relay-robot-source.service']) {
      const text = unit(name);
      assert.match(text, /Restart=on-failure/, name);
      assert.match(text, /StartLimitBurst=/, `${name} would otherwise respawn indefinitely`);
      assert.match(text, /WantedBy=default\.target/, `${name} must install into the user manager`);
      assert.doesNotMatch(text, /RELAY_KEY=/, `${name} is in the repository and must not carry the key`);
    }
    assert.match(unit('relay-server.service'), /ExecStart=\/usr\/bin\/npm start/);
  });

  test('systemd accepts the unit files', { skip: systemdVerifySkip() }, () => {
    const result = spawnSync('systemd-analyze', [
      '--user',
      'verify',
      './relay-server.service',
      './relay-robot-source.service',
    ], { cwd: path.join(root, 'deploy'), encoding: 'utf8' });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
});
