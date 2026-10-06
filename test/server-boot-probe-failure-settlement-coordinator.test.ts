import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const workflow = parseTypeScriptSource(
  new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-boot-probe-failure-settlement-coordinator.ts', import.meta.url),
  readFileSync(
    new URL('../src/relay-boot-probe-failure-settlement-coordinator.ts', import.meta.url),
    'utf8',
  ),
);

test('failProbeAttempt keeps probe authority local and delegates only its nullable decision', () => {
  const failure = functionCode(workflow, 'failProbeAttempt');
  assert.match(
    failure,
    /const failure = bootProbeRuntime\.failAttempt\(target, reason, nowMs\);[\s\S]*bootProbeFailureSettlementCoordinator\.settle\(failure\);/,
  );
  assert.doesNotMatch(failure, /timingRuntime\./);
  assert.doesNotMatch(failure, /calibration\.failPreservingPrimed\(/);
  assert.doesNotMatch(failure, /broadcastJson\(/);
  assert.doesNotMatch(failure, /timingCalibrationStatusPayload\(/);
});

test('server composition retains terminal settlement authorities', () => {
  assert.ok(
    importSources(workflow).includes('./relay-boot-probe-failure-settlement-coordinator.js'),
  );
  const composition = variableInitializerCode(workflow, 'bootProbeFailureSettlementCoordinator');
  assert.match(composition, /^createRelayBootProbeFailureSettlementCoordinator\(\{/);
  assert.match(
    composition,
    /restoreCandidateKindToAuthority: \(\) => timingRuntime\.restoreCandidateKindToAuthority\(\)/,
  );
  assert.match(
    composition,
    /failPreservingPrimed: message => calibration\.failPreservingPrimed\(message\)/,
  );
  assert.match(
    composition,
    /reportTimingStatus: \(\) => effects\.reportTimingStatus\(\)/,
  );
});

test('Boot Probe failure settlement coordinator owns consequences without runtime authority', () => {
  const code = sourceCode(coordinator);
  assert.doesNotMatch(code, /^import /m);
  assert.doesNotMatch(
    code,
    /bootProbeRuntime\.|timingRuntime\.|calibration\.|broadcastJson|ProbeLifecycle|BootProbeRuntime|TimingRuntime|CalibrationSession|AudioSession/,
  );
});
