import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(
  new URL('../src/relay-manual-boot-recalibration-coordinator.ts', import.meta.url),
  'utf8',
);

function functionBlock(name: string) {
  return server.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0] ?? '';
}

test('manual Robot recalibration delegates only after server command authority', () => {
  assert.match(
    server,
    /import \{ createRelayManualBootRecalibrationCoordinator \} from '\.\/relay-manual-boot-recalibration-coordinator\.js';/,
  );
  assert.match(server, /requireMicOwnerCommand\(socket, 'start-timing-calibration'\)/);
  assert.match(server, /productStatusPayload\(nowMs\)\.actions/);
  assert.match(server, /restartManualBootCalibration\(nowMs\)/);

  const restart = functionBlock('restartManualBootCalibration');
  assert.match(restart, /manualBootRecalibrationCoordinator\.restart\(nowMs\)/);
  assert.doesNotMatch(restart, /calibration\./);
  assert.doesNotMatch(restart, /timingRuntime\./);
  assert.doesNotMatch(restart, /bootProbeRuntime\./);
  assert.doesNotMatch(restart, /abandonProbeRun\(/);
  assert.doesNotMatch(restart, /syncAppliedCalibration\(/);
  assert.doesNotMatch(restart, /broadcastJson\(/);
});

test('server composition retains candidate-state and publication effects', () => {
  const start = server.indexOf('const manualBootRecalibrationCoordinator =');
  const end = server.indexOf('function restartManualBootCalibration', start);
  assert.ok(start >= 0 && end > start, 'manual recalibration composition must remain identifiable');
  const composition = server.slice(start, end);

  assert.match(composition, /clearContentValidation: \(\) => clearContentValidationBaseline\(\)/);
  assert.match(composition, /beginExternalRecalibration: \(\) => calibration\.beginExternalRecalibration\(\)/);
  assert.match(composition, /beginManualBootProbe: \(\) => timingRuntime\.beginBootProbe\(false\)/);
  assert.match(composition, /abandonProbeRun: \(\) => abandonProbeRun\(\)/);
  assert.match(composition, /resetProbeCorrelations: \(\) => bootProbeRuntime\.resetCorrelations\(\)/);
  assert.match(composition, /syncAppliedCalibration: \(\) => syncAppliedCalibration\(\)/);
  assert.match(composition, /maybeStartProbeCalibration: \(nowMs\) => maybeStartProbeCalibration\(nowMs\)/);
  assert.match(composition, /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
  assert.match(composition, /reportSourceStatus: \(\) => broadcastJson\(sourceStatusPayload\(\)\)/);
});

test('manual recalibration coordinator owns no runtime or command authority', () => {
  assert.doesNotMatch(
    coordinator,
    /from '\.\/(?:calibration-session|timing-runtime|boot-probe-runtime|command-authority|product-view-model)\.js'/,
  );
  assert.doesNotMatch(
    coordinator,
    /calibration\.|timingRuntime|bootProbeRuntime|requireMicOwnerCommand|productStatusPayload|broadcastJson/,
  );
});
