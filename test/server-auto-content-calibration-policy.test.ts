import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function functionBlock(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = server.indexOf('\nfunction ', start + 1);
  return server.slice(start, next === -1 ? server.length : next);
}

test('automatic content admission samples applied authority only when needed', () => {
  const block = functionBlock('maybeAutoCalibrate');
  assert.match(block, /autoContentCalibrationPrerequisitesReady\(\{/);
  assert.match(block, /bootProbeSettled:\s*bootProbeSettled\(nowMs\)/);
  assert.match(
    block,
    /robotEvidenceMappingReady:\s*!robotRoute \|\| robotContentEvidenceMappingReady\(nowMs\)/,
  );
  assert.match(
    block,
    /const appliedKind = freshConfirmedResult && robotRoute\s*\? appliedCalibrationKind\(\)\s*:\s*null/,
    'the applied-authority query remains conditional on fresh Robot authority',
  );
  assert.match(block, /autoContentCalibrationAuthorityAllowsStart\(\{/);
});

test('automatic content liveness preserves the old short-circuit sampling order', () => {
  const block = functionBlock('maybeAutoCalibrate');
  assert.match(block, /const retryDue = timingRuntime\.autoCalibrationDue\(nowMs\)/);
  assert.match(block, /const backingConnected = retryDue && backingRuntime\.connected\(\)/);
  assert.match(block, /const micControlConnected = backingConnected && micRuntime\.controlConnected\(\)/);
  assert.match(block, /const streamsFlowing = micControlConnected && bothStreamsFlowing\(nowMs\)/);
  assert.match(block, /const timeline = streamsFlowing \? currentTimelineStatus\(\) : null/);
  assert.match(block, /autoContentCalibrationLivePathReady\(\{/);
});

test('automatic content effects stay in the server and choose start mode after begin', () => {
  const block = functionBlock('maybeAutoCalibrate');
  const begin = block.indexOf('timingRuntime.beginContentCalibration(nowMs, true)');
  const mode = block.indexOf('autoContentCalibrationStartMode(probeCalibrationExhausted(nowMs))');
  assert.ok(begin >= 0, 'TimingRuntime must still own beginning the automatic run');
  assert.ok(mode > begin, 'probe exhaustion/start-mode sampling must stay after beginContentCalibration');
  assert.match(block, /calibration\.startFromPrimed\(nowMs\)/);
  assert.match(block, /calibration\.start\(nowMs\)/);
  assert.match(block, /broadcastJson\(timingCalibrationStatusPayload\(\)\)/);
});
