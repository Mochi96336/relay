import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const owner = parseTypeScriptSource(new URL('../src/relay-calibration-orchestration.ts', import.meta.url),
  readFileSync(new URL('../src/relay-calibration-orchestration.ts', import.meta.url), 'utf8'));

function functionBlock(name: string) {
  return functionCode(owner, name);
}

test('automatic content admission samples applied authority only when needed', () => {
  const block = functionBlock('maybeAutoCalibrate');
  assert.match(block, /autoContentCalibrationPrerequisitesReady\(\{/);
  assert.match(block, /bootProbeSettled:\s*queries\.bootProbeSettled\(nowMs\)/);
  assert.match(
    block,
    /robotEvidenceMappingReady:\s*!robotRoute \|\| queries\.robotContentEvidenceMappingReady\(nowMs\)/,
  );
  assert.match(
    block,
    /const appliedKind = freshConfirmedResult && robotRoute\s*\? queries\.appliedCalibrationKind\(\)\s*:\s*null/,
    'the applied-authority query remains conditional on fresh Robot authority',
  );
  assert.match(block, /autoContentCalibrationAuthorityAllowsStart\(\{/);
});

test('automatic content liveness preserves the old short-circuit sampling order', () => {
  const block = functionBlock('maybeAutoCalibrate');
  assert.match(block, /const retryDue = timingRuntime\.autoCalibrationDue\(nowMs\)/);
  assert.match(block, /const backingConnected = retryDue && backingRuntime\.connected\(\)/);
  assert.match(block, /const micControlConnected = backingConnected && micRuntime\.controlConnected\(\)/);
  assert.match(block, /const streamsFlowing = micControlConnected && queries\.bothStreamsFlowing\(nowMs\)/);
  assert.match(block, /const timeline = streamsFlowing \? queries\.currentTimelineStatus\(\) : null/);
  assert.match(block, /autoContentCalibrationLivePathReady\(\{/);
});

test('automatic content chooses start mode after begin and publishes through the canonical server port', () => {
  const block = functionBlock('maybeAutoCalibrate');
  const begin = block.indexOf('timingRuntime.beginContentCalibration(nowMs, true)');
  const mode = block.indexOf('autoContentCalibrationStartMode(queries.probeCalibrationExhausted(nowMs))');
  assert.ok(begin >= 0, 'TimingRuntime must still own beginning the automatic run');
  assert.ok(mode > begin, 'probe exhaustion/start-mode sampling must stay after beginContentCalibration');
  assert.match(block, /calibration\.startFromPrimed\(nowMs\)/);
  assert.match(block, /calibration\.start\(nowMs\)/);
  assert.match(block, /effects\.reportTimingStatus\(\)/);
  assert.match(variableInitializerCode(parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server), 'relayContentCalibration'),
    /reportTimingStatus: \(\) => broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});
