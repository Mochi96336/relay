import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RobotSemanticRecoveryExec } from '../src/robot-semantic-recovery-adapter.js';
import { robotSemanticRecoveryDryRunStatePath } from '../src/robot-semantic-recovery-dry-run.js';
import {
  readRobotSemanticRecoveryLiveState,
  robotSemanticRecoveryLiveStatePath,
  runRobotSemanticRecoveryLiveOnce,
  writeRobotSemanticRecoveryLiveState,
} from '../src/robot-semantic-recovery-live.js';
import type {
  RobotSemanticRecoveryConfig,
  RobotSemanticRecoveryState,
} from '../src/robot-semantic-recovery-policy.js';

const config: RobotSemanticRecoveryConfig = {
  faultGraceMs: 30_000,
  cooldownMs: 60_000,
  budgetWindowMs: 10 * 60_000,
  maxRestarts: 3,
};

function status(overrides: {
  generatedAt?: string;
  uptimeMs?: number;
  connected?: boolean;
  streaming?: boolean;
  robot?: boolean;
  frameAgeMs?: number | null;
  sourceConnected?: boolean;
  backingStarvedFrames?: number;
} = {}) {
  return {
    schema: 'relay.observation.v1',
    generatedAt: overrides.generatedAt ?? '2026-09-08T00:00:00.000Z',
    workload: {
      id: 'relay',
      state: 'live',
      ok: true,
      uptimeMs: overrides.uptimeMs ?? 100_000,
    },
    sources: {
      backing: {
        connected: overrides.connected ?? true,
        streaming: overrides.streaming ?? true,
        robot: overrides.robot ?? true,
        frameAgeMs: overrides.frameAgeMs === undefined ? 20 : overrides.frameAgeMs,
      },
      robot: {
        sourceConnected: overrides.sourceConnected ?? true,
      },
    },
    mix: {
      backingStarvedFrames: overrides.backingStarvedFrames ?? 0,
    },
  };
}

type FetchStep = unknown | Error;

function sequenceFetch(steps: FetchStep[], calls: number[] = []): typeof fetch {
  let index = 0;
  return async () => {
    calls.push(index);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function controlledExec(options: {
  showStates?: Array<string | Error>;
  restartError?: Error;
  calls?: Array<{ file: string; args: string[] }>;
} = {}): RobotSemanticRecoveryExec {
  let showIndex = 0;
  const states = options.showStates ?? ['active'];
  return async (file, args) => {
    options.calls?.push({ file, args: [...args] });
    if (args.includes('restart')) {
      if (options.restartError) throw options.restartError;
      return { stdout: '', stderr: '' };
    }
    const state = states[Math.min(showIndex, states.length - 1)];
    showIndex += 1;
    if (state instanceof Error) throw state;
    return { stdout: `${state}\n`, stderr: '' };
  };
}

function restartCount(calls: Array<{ file: string; args: string[] }>) {
  return calls.filter((call) => call.args.includes('restart')).length;
}

async function seededStateFile(state: RobotSemanticRecoveryState) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-recovery-live-'));
  const stateFile = robotSemanticRecoveryLiveStatePath(directory);
  await writeRobotSemanticRecoveryLiveState(stateFile, state);
  return { directory, stateFile };
}

function restartCandidateState(): RobotSemanticRecoveryState {
  return {
    faultKey: 'backing-not-connected|robot-source-not-connected',
    faultSinceMs: 100_000,
    cooldownUntilMs: 0,
    restartHistoryMs: [],
  };
}

function fakeVerificationClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (delayMs: number) => { now += delayMs; },
  };
}

const fault = status({
  connected: false,
  streaming: false,
  sourceConnected: false,
  frameAgeMs: null,
});

const healthy1 = status({
  generatedAt: '2026-09-08T00:00:01.000Z',
  uptimeMs: 200_000,
  frameAgeMs: 20,
  backingStarvedFrames: 40,
});
const healthy2 = status({
  generatedAt: '2026-09-08T00:00:02.000Z',
  uptimeMs: 201_000,
  frameAgeMs: 10,
  backingStarvedFrames: 40,
});
const healthy3 = status({
  generatedAt: '2026-09-08T00:00:03.000Z',
  uptimeMs: 202_000,
  frameAgeMs: 10,
  backingStarvedFrames: 40,
});

test('live recovery state is separate from dry-run authority and mode 0600', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-recovery-state-'));
  const live = robotSemanticRecoveryLiveStatePath(directory);
  const dry = robotSemanticRecoveryDryRunStatePath(directory);
  assert.notEqual(live, dry);
  assert.match(live, /relay-robot-semantic-recovery-live\.json$/);

  await writeRobotSemanticRecoveryLiveState(live, restartCandidateState());
  assert.deepEqual(await readRobotSemanticRecoveryLiveState(live), restartCandidateState());
  assert.equal((await stat(live)).mode & 0o777, 0o600);
});

test('one live restart is successful only after two snapshots prove continuing PCM', async () => {
  const { stateFile } = await seededStateFile(restartCandidateState());
  const calls: Array<{ file: string; args: string[] }> = [];
  const clock = fakeVerificationClock();
  const result = await runRobotSemanticRecoveryLiveOnce({
    stateFile,
    nowMs: 130_000,
    port: 3100,
    requestTimeoutMs: 1000,
    verificationTimeoutMs: 5_000,
    verificationSampleIntervalMs: 1_000,
    config,
    fetchImpl: sequenceFetch([fault, healthy1, healthy2]),
    exec: controlledExec({ calls }),
    verificationNow: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.evidenceAvailable, true);
  assert.equal(result.decision?.action, 'restart');
  assert.equal(result.restartAttempted, true);
  assert.equal(result.recovered, true);
  assert.equal(result.verification?.cause, 'pcm-progressing');
  assert.equal(result.verification?.samples, 2);
  assert.equal(restartCount(calls), 1);

  const persisted = await readRobotSemanticRecoveryLiveState(stateFile);
  assert.deepEqual(persisted.restartHistoryMs, [130_000]);
  assert.equal(persisted.cooldownUntilMs, 190_000);
});

test('operator stop between decision and effect prevents restart without spending budget', async () => {
  const { stateFile } = await seededStateFile(restartCandidateState());
  const calls: Array<{ file: string; args: string[] }> = [];
  const result = await runRobotSemanticRecoveryLiveOnce({
    stateFile,
    nowMs: 130_000,
    port: 3100,
    requestTimeoutMs: 1000,
    verificationTimeoutMs: 5_000,
    verificationSampleIntervalMs: 1_000,
    config,
    fetchImpl: sequenceFetch([fault]),
    exec: controlledExec({ showStates: ['active', 'inactive'], calls }),
  });

  assert.equal(result.restartAttempted, false);
  assert.equal(result.decision?.cause, 'route-service-inactive');
  assert.equal(restartCount(calls), 0);
  assert.deepEqual((await readRobotSemanticRecoveryLiveState(stateFile)).restartHistoryMs, []);
});

test('failed restart still consumes cooldown and budget and never retries in the same run', async () => {
  const { stateFile } = await seededStateFile(restartCandidateState());
  const calls: Array<{ file: string; args: string[] }> = [];
  const result = await runRobotSemanticRecoveryLiveOnce({
    stateFile,
    nowMs: 130_000,
    port: 3100,
    requestTimeoutMs: 1000,
    verificationTimeoutMs: 5_000,
    verificationSampleIntervalMs: 1_000,
    config,
    fetchImpl: sequenceFetch([fault]),
    exec: controlledExec({ calls, restartError: new Error('restart failed') }),
  });

  assert.equal(result.restartAttempted, true);
  assert.equal(result.recovered, false);
  assert.match(result.error?.message ?? '', /restart failed/);
  assert.equal(restartCount(calls), 1);
  const persisted = await readRobotSemanticRecoveryLiveState(stateFile);
  assert.deepEqual(persisted.restartHistoryMs, [130_000]);
  assert.equal(persisted.cooldownUntilMs, 190_000);
});

test('one reconnect frame followed by silence times out and cannot trigger a second restart', async () => {
  const { stateFile } = await seededStateFile(restartCandidateState());
  const calls: Array<{ file: string; args: string[] }> = [];
  const clock = fakeVerificationClock();
  const stalled2 = status({
    generatedAt: '2026-09-08T00:00:02.000Z',
    uptimeMs: 201_000,
    frameAgeMs: 1_020,
    backingStarvedFrames: 40,
  });
  const stalled3 = status({
    generatedAt: '2026-09-08T00:00:03.000Z',
    uptimeMs: 202_000,
    frameAgeMs: 2_020,
    backingStarvedFrames: 40,
  });
  const result = await runRobotSemanticRecoveryLiveOnce({
    stateFile,
    nowMs: 130_000,
    port: 3100,
    requestTimeoutMs: 1000,
    verificationTimeoutMs: 2_000,
    verificationSampleIntervalMs: 1_000,
    config,
    fetchImpl: sequenceFetch([fault, healthy1, stalled2, stalled3]),
    exec: controlledExec({ calls }),
    verificationNow: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.restartAttempted, true);
  assert.equal(result.recovered, false);
  assert.equal(result.verification?.cause, 'verification-timeout');
  assert.equal(result.verification?.proof?.cause, 'no-new-frame');
  assert.equal(restartCount(calls), 1);
  assert.deepEqual((await readRobotSemanticRecoveryLiveState(stateFile)).restartHistoryMs, [130_000]);
});

test('unknown systemd state during verification resets the two-snapshot proof', async () => {
  const { stateFile } = await seededStateFile(restartCandidateState());
  const calls: Array<{ file: string; args: string[] }> = [];
  const fetchCalls: number[] = [];
  const clock = fakeVerificationClock();
  const result = await runRobotSemanticRecoveryLiveOnce({
    stateFile,
    nowMs: 130_000,
    port: 3100,
    requestTimeoutMs: 1000,
    verificationTimeoutMs: 4_000,
    verificationSampleIntervalMs: 1_000,
    config,
    fetchImpl: sequenceFetch([fault, healthy1, healthy2, healthy3], fetchCalls),
    exec: controlledExec({
      showStates: ['active', 'active', 'active', new Error('systemd unavailable'), 'active', 'active'],
      calls,
    }),
    verificationNow: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.recovered, true);
  assert.equal(result.verification?.cause, 'pcm-progressing');
  assert.equal(result.verification?.samples, 3,
    'the status sample before the systemd blind spot cannot be paired across it');
  assert.equal(fetchCalls.length, 4,
    'the blind ActiveState iteration must not fetch or contribute ProductStatus evidence');
  assert.equal(restartCount(calls), 1);
});

test('route becoming inactive during verification stops recovery without another restart', async () => {
  const { stateFile } = await seededStateFile(restartCandidateState());
  const calls: Array<{ file: string; args: string[] }> = [];
  const clock = fakeVerificationClock();
  const result = await runRobotSemanticRecoveryLiveOnce({
    stateFile,
    nowMs: 130_000,
    port: 3100,
    requestTimeoutMs: 1000,
    verificationTimeoutMs: 5_000,
    verificationSampleIntervalMs: 1_000,
    config,
    fetchImpl: sequenceFetch([fault, healthy1]),
    exec: controlledExec({ showStates: ['active', 'active', 'inactive'], calls }),
    verificationNow: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.restartAttempted, true);
  assert.equal(result.recovered, false);
  assert.equal(result.verification?.cause, 'route-inactive');
  assert.equal(result.verification?.samples, 0);
  assert.equal(restartCount(calls), 1);
});
