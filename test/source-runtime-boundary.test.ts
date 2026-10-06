import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  importSources,
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const runtime = parseTypeScriptSource(
  new URL('../src/source-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/source-runtime.ts', import.meta.url), 'utf8'),
);
const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const mapping = parseTypeScriptSource(
  new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'),
);
const application = parseTypeScriptSource(
  new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'),
);

test('SourceRuntime owns source identity without absorbing mapping or product effects', () => {
  const runtimeCode = sourceCode(runtime);
  const serverCode = sourceCode(server);
  const sourceRuntime = variableInitializerCode(server, 'sourceRuntime');
  const mappingComposition = variableInitializerCode(server, 'relayRobotMapping');
  const revocation = variableInitializerCode(mapping, 'revocation');
  const disconnect = variableInitializerCode(mapping, 'disconnect');
  const activation = variableInitializerCode(mapping, 'activation');

  assert.deepEqual(importSources(runtime), [], 'SourceRuntime must stay dependency-free');
  assert.match(sourceRuntime, /^new SourceRuntime<RelaySocket>/);
  assert.match(sourceCode(application), /sourceGeneration: sourceRuntime\.generation/);
  assert.match(variableInitializerCode(server, 'relayCalibration'), /source: sourceRuntime/);
  assert.match(serverCode, /sourceRuntime\.attachRobot\(socket\)/);
  assert.match(disconnect, /isActive: \(socket\) => dependencies\.source\.isActive\(socket\)/);
  assert.match(disconnect, /detach: \(socket\) => dependencies\.source\.detachRobot\(socket\)/);
  assert.match(serverCode, /relayRobotMapping\.disconnectSource\(socket\)/);
  assert.match(functionCode(mapping, 'createRelayRobotMappingOrchestration'), /createRelayRobotSourceLifecycle\(dependencies, \{/);
  assert.match(functionCode(mapping, 'createRelayRobotSourceLifecycle'), /disconnectSource: disconnect\.handle/);
  assert.match(mappingComposition, /source: sourceRuntime/);
  assert.match(revocation, /invalidateSourceMapping: \(\) => dependencies\.source\.invalidateMapping\(\)/);
  assert.ok(importSources(mapping).includes('./relay-robot-content-mapping-revocation-coordinator.js'));
  assert.match(serverCode, /sourceRuntime\.canReportSeek\(socket\)/);

  assert.doesNotMatch(serverCode, /let activeRobotSource: RelaySocket \| null/);
  assert.doesNotMatch(serverCode, /let sourceGeneration =/);
  assert.doesNotMatch(serverCode, /sourceGeneration \+= 1/);

  // Domain consequences stay explicit in application orchestration. Canonical
  // owner binding and the reused coordinator's narrow ports establish the path
  // without making SourceRuntime absorb mapping or publication policy.
  assert.match(activation, /noteQualityEvent: \(event\) => dependencies\.take\.noteQualityEvent\(event\)/);
  assert.match(mappingComposition, /take: takeController/);
  assert.match(mappingComposition, /offset: robotPlayerOffset/);
  assert.match(mappingComposition, /timeline: robotContentTimeline/);
  assert.match(mappingComposition, /\bcalibration,/);
  assert.match(revocation, /resetPlayerOffset: \(\) => dependencies\.offset\.reset\(\)/);
  assert.match(revocation, /resetContentTimeline: \(\) => dependencies\.timeline\.reset\(\)/);
  assert.match(revocation, /discardPrimedContent: \(\) => dependencies\.calibration\.discardPrimedContent\(\)/);
  assert.doesNotMatch(runtimeCode, /noteQualityEvent|discardPrimedContent|sendJson|broadcastJson/);
});
