import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateRobotSemanticRecoveryDryRun,
  fetchRobotSemanticRecoveryObservation,
  parseRobotSemanticRecoveryObservationPayload,
  proveRobotBackingPcmProgress,
  readRobotRouteServiceActive,
  robotSemanticRecoveryObservationUrl,
  type RobotSemanticRecoveryExec,
} from '../src/robot-semantic-recovery-adapter.js';
import type {
  RobotSemanticRecoveryConfig,
  RobotSemanticRecoveryState,
} from '../src/robot-semantic-recovery-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config: RobotSemanticRecoveryConfig = {
  faultGraceMs: 30_000,
  cooldownMs: 60_000,
  budgetWindowMs: 10 * 60_000,
  maxRestarts: 3,
};

function status(overrides: {
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
    generatedAt: '2026-09-08T00:00:00.000Z',
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
        sampleRate: 48_000,
        unrelatedFutureField: 'ignored',
      },
      robot: {
        routeActive: true,
        sourceConnected: overrides.sourceConnected ?? true,
        playerDeltaFresh: false,
      },
      microphone: { connected: false },
    },
    mix: {
      backingStarvedFrames: overrides.backingStarvedFrames ?? 12,
      unrelatedFutureField: 'ignored',
    },
    issues: { faults: ['future-fault-that-must-not-grant-authority'], warnings: [] },
  };
}

function fetchJson(
  body: unknown,
  responseStatus = 200,
  calls: string[] = [],
): typeof fetch {
  return async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: responseStatus,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function execActive(activeState = 'active', calls: Array<{ file: string; args: string[] }> = []): RobotSemanticRecoveryExec {
  return async (file, args) => {
    calls.push({ file, args });
    return { stdout: `${activeState}\n`, stderr: '' };
  };
}

test('parser validates only the status-v1 fields used for recovery authority and PCM proof', () => {
  assert.deepEqual(parseRobotSemanticRecoveryObservationPayload(status()), {
    workload: { uptimeMs: 100_000 },
    sources: {
      backing: { connected: true, streaming: true, robot: true, frameAgeMs: 20 },
      robot: { sourceConnected: true },
    },
    mix: { backingStarvedFrames: 12 },
  });

  assert.equal(parseRobotSemanticRecoveryObservationPayload({ ...status(), schema: 'relay.observation.v2' }), null);
  assert.equal(parseRobotSemanticRecoveryObservationPayload(status({ uptimeMs: -1 })), null);
  assert.equal(parseRobotSemanticRecoveryObservationPayload({
    ...status(),
    sources: {
      ...status().sources,
      backing: { connected: true, streaming: true, robot: 'yes', frameAgeMs: 20 },
    },
  }), null);
  assert.equal(parseRobotSemanticRecoveryObservationPayload(status({ frameAgeMs: -1 })), null);
  assert.equal(parseRobotSemanticRecoveryObservationPayload(status({ backingStarvedFrames: 1.5 })), null);
});

test('post-restart proof requires continuing Backing frames without new mixer starvation', () => {
  const previous = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 100_000,
    frameAgeMs: 20,
    backingStarvedFrames: 40,
  }));
  const current = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 101_000,
    frameAgeMs: 10,
    backingStarvedFrames: 40,
  }));
  assert.ok(previous && current);

  const proof = proveRobotBackingPcmProgress(previous, current);
  assert.equal(proof.progressing, true);
  assert.equal(proof.cause, 'progressing');
  assert.equal(proof.previousFrameObservedAtMs, 99_980);
  assert.equal(proof.currentFrameObservedAtMs, 100_990);
});

test('one reconnect frame followed by silence is not accepted as recovered PCM', () => {
  const previous = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 100_000,
    frameAgeMs: 20,
    backingStarvedFrames: 40,
  }));
  const current = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 101_000,
    frameAgeMs: 1_020,
    backingStarvedFrames: 40,
  }));
  assert.ok(previous && current);

  const proof = proveRobotBackingPcmProgress(previous, current);
  assert.equal(proof.progressing, false);
  assert.equal(proof.cause, 'no-new-frame');
  assert.equal(proof.currentFrameObservedAtMs, proof.previousFrameObservedAtMs);
});

test('Relay restart invalidates cross-incarnation PCM comparison', () => {
  const previous = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 100_000,
    frameAgeMs: 20,
  }));
  const current = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 500,
    frameAgeMs: 10,
  }));
  assert.ok(previous && current);

  const proof = proveRobotBackingPcmProgress(previous, current);
  assert.equal(proof.progressing, false);
  assert.equal(proof.cause, 'observation-not-advancing');
});

test('fresh packet timestamps do not hide a mixer that is still starving', () => {
  const previous = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 100_000,
    frameAgeMs: 20,
    backingStarvedFrames: 40,
  }));
  const current = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 101_000,
    frameAgeMs: 10,
    backingStarvedFrames: 41,
  }));
  assert.ok(previous && current);

  const proof = proveRobotBackingPcmProgress(previous, current);
  assert.equal(proof.progressing, false);
  assert.equal(proof.cause, 'mixer-starved');
});

test('progress proof rejects transport flags that are not fully Robot-ready', () => {
  const previous = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 100_000,
    frameAgeMs: 20,
  }));
  const current = parseRobotSemanticRecoveryObservationPayload(status({
    uptimeMs: 101_000,
    frameAgeMs: 10,
    sourceConnected: false,
  }));
  assert.ok(previous && current);

  const proof = proveRobotBackingPcmProgress(previous, current);
  assert.equal(proof.progressing, false);
  assert.equal(proof.cause, 'source-not-ready');
});

test('observation URL is pinned to IPv4 loopback and the versioned contract', () => {
  assert.equal(robotSemanticRecoveryObservationUrl(3100), 'http://127.0.0.1:3100/api/status/v1');
  assert.throws(() => robotSemanticRecoveryObservationUrl(0), /1 to 65535/);
  assert.throws(() => robotSemanticRecoveryObservationUrl(65_536), /1 to 65535/);
  assert.throws(() => robotSemanticRecoveryObservationUrl(3100.5), /integer/);
});

test('observation fetch cannot be redirected away from local Relay', async () => {
  const calls: string[] = [];
  const observation = await fetchRobotSemanticRecoveryObservation(3100, 1000, fetchJson(status(), 200, calls));
  assert.equal(observation.workload.uptimeMs, 100_000);
  assert.equal(observation.sources.backing.connected, true);
  assert.equal(observation.sources.backing.frameAgeMs, 20);
  assert.equal(observation.mix.backingStarvedFrames, 12);
  assert.deepEqual(calls, ['http://127.0.0.1:3100/api/status/v1']);
});

test('observation fetch rejects non-success and schema-invalid evidence', async () => {
  await assert.rejects(
    fetchRobotSemanticRecoveryObservation(3100, 1000, fetchJson({}, 503)),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchRobotSemanticRecoveryObservation(3100, 1000, fetchJson({ schema: 'wrong' })),
    /does not match/,
  );
});

test('systemd read is pinned to one user unit and never turns inactive into active intent', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  assert.equal(await readRobotRouteServiceActive(3000, execActive('active', calls)), true);
  assert.equal(await readRobotRouteServiceActive(3000, execActive('inactive')), false);
  assert.equal(await readRobotRouteServiceActive(3000, execActive('failed')), false);

  assert.deepEqual(calls, [{
    file: '/usr/bin/systemctl',
    args: ['--user', 'show', '--property=ActiveState', '--value', 'relay-robot-source.service'],
  }]);
});

test('dry-run can produce a restart candidate without owning any restart effect', async () => {
  const state: RobotSemanticRecoveryState = {
    faultKey: 'backing-not-connected|robot-source-not-connected',
    faultSinceMs: 100_000,
    cooldownUntilMs: 0,
    restartHistoryMs: [],
  };
  const calls: Array<{ file: string; args: string[] }> = [];
  const result = await evaluateRobotSemanticRecoveryDryRun(state, 130_000, config, {
    port: 3100,
    requestTimeoutMs: 1000,
    fetchImpl: fetchJson(status({ connected: false, sourceConnected: false })),
    exec: execActive('active', calls),
  });

  assert.equal(result.evidenceAvailable, true);
  if (!result.evidenceAvailable) return;
  assert.equal(result.decision.action, 'restart');
  assert.deepEqual(result.decision.faults, ['backing-not-connected', 'robot-source-not-connected']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args.includes('restart'), false);
});

test('inactive route service remains operator intent even with missing Robot evidence', async () => {
  const state: RobotSemanticRecoveryState = {
    faultKey: 'backing-not-connected',
    faultSinceMs: 1,
    cooldownUntilMs: 0,
    restartHistoryMs: [],
  };
  const result = await evaluateRobotSemanticRecoveryDryRun(state, 100_000, config, {
    port: 3100,
    requestTimeoutMs: 1000,
    fetchImpl: fetchJson(status({ connected: false, sourceConnected: false })),
    exec: execActive('inactive'),
  });

  assert.equal(result.evidenceAvailable, true);
  if (!result.evidenceAvailable) return;
  assert.equal(result.decision.action, 'none');
  assert.equal(result.decision.cause, 'route-service-inactive');
});

test('blind polls clear continuous-fault timing but preserve cooldown and restart budget', async () => {
  const state: RobotSemanticRecoveryState = {
    faultKey: 'backing-not-connected',
    faultSinceMs: 40_000,
    cooldownUntilMs: 200_000,
    restartHistoryMs: [10_000, 20_000],
  };
  const result = await evaluateRobotSemanticRecoveryDryRun(state, 100_000, config, {
    port: 3100,
    requestTimeoutMs: 1000,
    fetchImpl: async () => { throw new Error('Relay unavailable'); },
    exec: execActive('active'),
  });

  assert.equal(result.evidenceAvailable, false);
  if (result.evidenceAvailable) return;
  assert.equal(result.state.faultKey, null);
  assert.equal(result.state.faultSinceMs, null);
  assert.equal(result.state.cooldownUntilMs, 200_000);
  assert.deepEqual(result.state.restartHistoryMs, [10_000, 20_000]);
  assert.match(result.error.message, /Relay unavailable/);
});

test('adapter scope is read-only: no supervisor unit, package entry, or systemctl restart effect', () => {
  const source = readFileSync(path.join(root, 'src', 'robot-semantic-recovery-adapter.ts'), 'utf8');
  const packageJson = readFileSync(path.join(root, 'package.json'), 'utf8');
  const deployFiles = readdirSync(path.join(root, 'deploy'));

  assert.match(source, /--property=ActiveState/);
  assert.match(source, /\/api\/status\/v1/);
  assert.doesNotMatch(source, /observationUrl/);
  assert.doesNotMatch(source, /\['--user',\s*'restart'/);
  assert.doesNotMatch(packageJson, /robot:supervisor/);
  assert.equal(deployFiles.includes('relay-robot-supervisor.service'), false);
});
