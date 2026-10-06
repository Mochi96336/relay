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

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const runtime = parseTypeScriptSource(
  new URL('../src/boot-probe-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/boot-probe-runtime.ts', import.meta.url), 'utf8'),
);
const serverCode = sourceCode(server);
const runtimeCode = sourceCode(runtime);
const workflow = parseTypeScriptSource(
  new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-boot-probe-orchestration.ts', import.meta.url), 'utf8'),
);
const workflowCode = sourceCode(workflow);

test('BootProbeRuntime aggregates probe evidence without absorbing calibration or media authority', () => {
  assert.deepEqual(
    importSources(runtime).sort(),
    ['./boot-calibration.js', './probe-lifecycle.js'].sort(),
    'BootProbeRuntime may depend only on the probe state machine and boot-result type',
  );

  const construction = variableInitializerCode(server, 'bootProbeRuntime');
  assert.ok(construction.includes('new BootProbeRuntime({'));
  assert.doesNotMatch(serverCode, /const probeLifecycle = new ProbeLifecycle\(/);
  assert.doesNotMatch(serverCode, /let probeRequestId =/);
  assert.doesNotMatch(serverCode, /let measuredMicLeg:/);
  assert.doesNotMatch(serverCode, /let lastProbeCorrelation:/);
  assert.doesNotMatch(serverCode, /let lastProbeContext:/);
  assert.doesNotMatch(serverCode, /let lastBootCalibration:/);
  assert.doesNotMatch(serverCode, /let bootPathDifferenceMs:/);
  assert.doesNotMatch(serverCode, /let bootConfidence:/);
  assert.doesNotMatch(
    serverCode,
    /bootProbeRuntime\.micLeg/,
    'server scheduler/composition code must not extract provisional Mic evidence directly',
  );
  assert.ok(serverCode.includes('bootProbeRuntime.hasMicLeg'));
  assert.ok(functionCode(workflow, 'maybeStartProbeCalibration').includes('bootProbeRuntime.micLegStaleForContext('));
  assert.ok(functionCode(workflow, 'maybeFinishProbeAnalysis').includes('bootProbeRuntime.takeMicLegForContext('));
  assert.ok(functionCode(workflow, 'maybeStartProbeCalibration').includes('bootProbeRuntime.lifecycleIdle'));
  assert.ok(serverCode.includes('bootProbeRuntime.takeExpiredRequest('));
  assert.doesNotMatch(serverCode, /bootProbeRuntime\.pendingRequest/);
  assert.doesNotMatch(serverCode, /bootProbeRuntime\.acceptReply\(/);

  // Signal analysis, combination and application remain orchestration/domain work.
  assert.ok(functionCode(workflow, 'maybeFinishProbeAnalysis').includes('locateProbe('));
  assert.ok(functionCode(workflow, 'maybeFinishProbeAnalysis').includes('combineBootCalibration('));
  const promotion = variableInitializerCode(workflow, 'bootProbeCalibrationPromotionCoordinator');
  assert.ok(promotion.includes('calibration.applyExternalResult('));
  assert.ok(promotion.includes('timingRuntime.markBootProbeAuthority()'));
  assert.match(variableInitializerCode(server, 'relayBootProbe'), /probe: bootProbeRuntime/);
  assert.match(variableInitializerCode(server, 'relayBootProbe'), /timing: timingRuntime/);
  assert.match(variableInitializerCode(server, 'relayBootProbe'), /\bcalibration,/);
  assert.doesNotMatch(workflowCode, /new (?:BootProbeRuntime|ProbeLifecycle|TimingRuntime|CalibrationSession|AudioSession)\(/);
  assert.doesNotMatch(workflowCode, /let (?:probeRequestId|measuredMicLeg|lastProbeCorrelation|lastProbeContext|lastBootCalibration|bootPathDifferenceMs|bootConfidence)\b/);
  assert.doesNotMatch(workflowCode, /bootProbeRuntime\.micLeg\b|bootProbeRuntime\.pendingRequest|bootProbeRuntime\.acceptReply\(/);
  assert.doesNotMatch(
    runtimeCode,
    /locateProbe|combineBootCalibration|applyExternalResult|markBootProbeAuthority|AudioSession|CalibrationSession|TimingRuntime/,
  );
});
