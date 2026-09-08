import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RobotSemanticRecoveryExec } from '../src/robot-semantic-recovery-adapter.js';
import {
  readRobotSemanticRecoveryDryRunState,
  robotSemanticRecoveryDryRunStatePath,
  runRobotSemanticRecoveryDryRunOnce,
  writeRobotSemanticRecoveryDryRunState,
} from '../src/robot-semantic-recovery-dry-run.js';
import {
  emptyRobotSemanticRecoveryState,
  type RobotSemanticRecoveryConfig,
  type RobotSemanticRecoveryState,
} from '../src/robot-semantic-recovery-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config: RobotSemanticRecoveryConfig = {
  faultGraceMs: 30_000,
  cooldownMs: 60_000,
  budgetWindowMs: 10 * 60_000,
  maxRestarts: 3,
};

function status(overrides: {
  connected?: boolean;
  streaming?: boolean;
  robot?: boolean;
  sourceConnected?: boolean;
} = {}) {
  return {
    schema: 'relay.observation.v1',
    sources: {
      backing: {
        connected: overrides.connected ?? true,
        streaming: overrides.streaming ?? true,
        robot: overrides.robot ?? true,
      },
      robot: {
        sourceConnected: overrides.sourceConnected ?? true,
      },
    },
  };
}

function fetchJson(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function execActive(calls: Array<{ file: string; args: string[] }> = []): RobotSemanticRecoveryExec {
  return async (file, args) => {
    calls.push({ file, args });
    return { stdout: 'active\n', stderr: '' };
  };
}

async function tempStateFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-recovery-dry-run-'));
  return {
    directory,
    stateFile: robotSemanticRecoveryDryRunStatePath(directory),
  };
}

test('dry-run state path requires an absolute XDG runtime directory', () => {
  assert.equal(
    robotSemanticRecoveryDryRunStatePath('/run/user/1000'),
    '/run/user/1000/relay-robot-semantic-recovery-dry-run.json',
  );
  assert.throws(() => robotSemanticRecoveryDryRunStatePath(undefined), /XDG_RUNTIME_DIR is required/);
  assert.throws(() => robotSemanticRecoveryDryRunStatePath(''), /XDG_RUNTIME_DIR is required/);
  assert.throws(() => robotSemanticRecoveryDryRunStatePath('relative/runtime'), /absolute path/);
});

test('dry-run state round-trips atomically with mode 0600', async () => {
  const { directory, stateFile } = await tempStateFile();
  assert.deepEqual(
    await readRobotSemanticRecoveryDryRunState(stateFile),
    emptyRobotSemanticRecoveryState(),
  );

  const state: RobotSemanticRecoveryState = {
    faultKey: 'backing-not-connected',
    faultSinceMs: 10_000,
    cooldownUntilMs: 20_000,
    restartHistoryMs: [1_000, 2_000],
  };
  await writeRobotSemanticRecoveryDryRunState(stateFile, state);

  assert.deepEqual(await readRobotSemanticRecoveryDryRunState(stateFile), state);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['relay-robot-semantic-recovery-dry-run.json']);
});

test('malformed persisted dry-run state fails closed instead of minting a fresh budget', async () => {
  const { stateFile } = await tempStateFile();
  await writeFile(stateFile, '{"faultKey":null}\n', { mode: 0o600 });

  await assert.rejects(
    readRobotSemanticRecoveryDryRunState(stateFile),
    /does not match the semantic recovery state contract/,
  );
});

test('repeated one-shot dry-runs accumulate grace and persist only a restart candidate', async () => {
  const { stateFile } = await tempStateFile();
  const calls: Array<{ file: string; args: string[] }> = [];
  const observation = status({ connected: false, sourceConnected: false });
  const common = {
    stateFile,
    port: 3100,
    requestTimeoutMs: 1000,
    config,
    fetchImpl: fetchJson(observation),
    exec: execActive(calls),
  };

  const first = await runRobotSemanticRecoveryDryRunOnce({ ...common, nowMs: 100_000 });
  assert.equal(first.evidenceAvailable, true);
  if (!first.evidenceAvailable) return;
  assert.equal(first.decision.action, 'observe');
  assert.equal(first.decision.state.faultSinceMs, 100_000);
  assert.equal(
    first.decision.state.faultKey,
    'backing-not-connected|robot-source-not-connected',
  );

  const second = await runRobotSemanticRecoveryDryRunOnce({ ...common, nowMs: 130_000 });
  assert.equal(second.evidenceAvailable, true);
  if (!second.evidenceAvailable) return;
  assert.equal(second.decision.action, 'restart');
  assert.deepEqual(second.decision.faults, [
    'backing-not-connected',
    'robot-source-not-connected',
  ]);

  const persisted = await readRobotSemanticRecoveryDryRunState(stateFile);
  assert.equal(persisted.faultKey, null);
  assert.equal(persisted.faultSinceMs, null);
  assert.equal(persisted.cooldownUntilMs, 190_000);
  assert.deepEqual(persisted.restartHistoryMs, [130_000]);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => !call.args.includes('restart')), true);
});

test('blind one-shot persists cleared fault evidence without erasing dry-run budget', async () => {
  const { stateFile } = await tempStateFile();
  await writeRobotSemanticRecoveryDryRunState(stateFile, {
    faultKey: 'backing-not-connected',
    faultSinceMs: 40_000,
    cooldownUntilMs: 200_000,
    restartHistoryMs: [10_000, 20_000],
  });

  const result = await runRobotSemanticRecoveryDryRunOnce({
    stateFile,
    nowMs: 100_000,
    port: 3100,
    requestTimeoutMs: 1000,
    config,
    fetchImpl: async () => { throw new Error('Relay unavailable'); },
    exec: execActive(),
  });
  assert.equal(result.evidenceAvailable, false);

  assert.deepEqual(await readRobotSemanticRecoveryDryRunState(stateFile), {
    faultKey: null,
    faultSinceMs: null,
    cooldownUntilMs: 200_000,
    restartHistoryMs: [10_000, 20_000],
  });
});

test('one-shot rejects invalid monotonic time before reading or mutating state', async () => {
  const { stateFile } = await tempStateFile();
  await assert.rejects(
    runRobotSemanticRecoveryDryRunOnce({
      stateFile,
      nowMs: Number.NaN,
      port: 3100,
      requestTimeoutMs: 1000,
      config,
      fetchImpl: fetchJson(status()),
      exec: execActive(),
    }),
    /monotonic time must be a non-negative integer/,
  );
  assert.deepEqual(await readdir(path.dirname(stateFile)), []);
});

test('manual dry-run scope has no polling loop, restart effect, or supervisor unit', async () => {
  const source = await readFile(
    path.join(root, 'src', 'robot-semantic-recovery-dry-run.ts'),
    'utf8',
  );
  const entry = await readFile(
    path.join(root, 'src', 'robot-semantic-recovery-dry-run-entry.ts'),
    'utf8',
  );
  const packageJson = await readFile(path.join(root, 'package.json'), 'utf8');
  const deployFiles = await readdir(path.join(root, 'deploy'));

  assert.doesNotMatch(source + entry, /setInterval|setTimeout as sleep|while\s*\(/);
  assert.doesNotMatch(source + entry, /\['--user',\s*'restart'/);
  assert.match(packageJson, /"robot:recovery-dry-run"/);
  assert.equal(deployFiles.includes('relay-robot-supervisor.service'), false);
  assert.equal(deployFiles.includes('relay-robot-semantic-recovery.service'), false);
});
