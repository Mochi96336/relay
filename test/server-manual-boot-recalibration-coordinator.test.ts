import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const coordinator = parseTypeScriptSource(
  new URL('../src/relay-manual-boot-recalibration-coordinator.ts', import.meta.url),
  readFileSync(new URL('../src/relay-manual-boot-recalibration-coordinator.ts', import.meta.url), 'utf8'),
);
const application = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));
const serverCode = sourceCode(server);
const coordinatorCode = sourceCode(coordinator);

test('manual Robot recalibration delegates only after server command authority', () => {
  assert.match(
    sourceCode(application),
    /import \{ createRelayManualBootRecalibrationCoordinator \} from '\.\/relay-manual-boot-recalibration-coordinator\.js';/,
  );
  assert.match(serverCode, /requireMicOwnerCommand\(socket, 'start-timing-calibration'\)/);
  assert.match(serverCode, /productStatusPayload\(nowMs\)\.actions/);
  assert.match(serverCode, /restartManualBootCalibration\(nowMs\)/);

  const restart = functionCode(server, 'restartManualBootCalibration');
  assert.match(restart, /relayCalibrationLifecycle\.restartManualBootCalibration\(nowMs\)/);
  assert.match(functionCode(application, 'restartManualBootCalibration'), /manualBootRecalibrationCoordinator\.restart\(nowMs\)/);
  assert.doesNotMatch(restart, /calibration\./);
  assert.doesNotMatch(restart, /timingRuntime\./);
  assert.doesNotMatch(restart, /bootProbeRuntime\./);
  assert.doesNotMatch(restart, /abandonProbeRun\(/);
  assert.doesNotMatch(restart, /syncAppliedCalibration\(/);
  assert.doesNotMatch(restart, /broadcastJson\(/);
});

test('server composition retains candidate-state and publication effects', () => {
  const composition = variableInitializerCode(application, 'manualBootRecalibrationCoordinator');
  const binding = variableInitializerCode(server, 'relayCalibrationLifecycle');

  assert.match(composition, /clearContentValidation: \(\) => commands\.clearContentValidation\(\)/);
  assert.match(binding, /clearContentValidation: clearContentValidationBaseline/);
  assert.match(composition, /beginExternalRecalibration: \(\) => calibration\.beginExternalRecalibration\(\)/);
  assert.match(composition, /beginManualBootProbe: \(\) => timingRuntime\.beginBootProbe\(false\)/);
  assert.match(composition, /abandonProbeRun: \(\) => commands\.abandonProbeRun\(\)/);
  assert.match(composition, /resetProbeCorrelations: \(\) => bootProbeRuntime\.resetCorrelations\(\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => commands\.syncAppliedCalibration\(\)/);
  assert.match(composition, /maybeStartProbeCalibration: \(nowMs\) => commands\.maybeStartProbeCalibration\(nowMs\)/);
  assert.match(composition, /reportTimingStatus: \(\) => effects\.reportTimingStatus\(\)/);
  assert.match(composition, /reportSourceStatus: \(\) => effects\.reportSourceStatus\(\)/);
  assert.match(binding, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(binding, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
});

test('manual recalibration coordinator owns no runtime or command authority', () => {
  assert.doesNotMatch(
    coordinatorCode,
    /from '\.\/(?:calibration-session|timing-runtime|boot-probe-runtime|command-authority|product-view-model)\.js'/,
  );
  assert.doesNotMatch(
    coordinatorCode,
    /calibration\.|timingRuntime|bootProbeRuntime|requireMicOwnerCommand|productStatusPayload|broadcastJson/,
  );
});
