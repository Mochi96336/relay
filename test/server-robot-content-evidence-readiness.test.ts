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

function commandHandlerBlock(name: string) {
  const start = server.indexOf(`  ${name}: (socket) => {`);
  assert.notEqual(start, -1, `${name} command handler must exist`);
  const next = server.indexOf('\n  },\n', start + 1);
  assert.notEqual(next, -1, `${name} command handler must have a closing boundary`);
  return server.slice(start, next + 5);
}

test('Robot content evidence readiness rejects a pending backing boundary even while the timeline is fresh', () => {
  const block = functionBlock('robotContentEvidenceMappingReady');
  assert.match(block, /robotContentMappingReady\(nowMs\)/);
  assert.match(block, /!robotContentTimeline\.needsBackingBoundary\(calibrationContext\(\)\)/);
});

test('priming, automatic calibration and content validation all require an evidence-usable Robot mapping', () => {
  assert.match(
    functionBlock('robotContentFallbackPrimingActive'),
    /!robotContentEvidenceMappingReady\(nowMs\)/,
  );
  assert.match(
    functionBlock('maybeAutoCalibrate'),
    /!robotContentEvidenceMappingReady\(nowMs\)/,
  );
  assert.match(
    functionBlock('contentValidationPathReady'),
    /!robotContentEvidenceMappingReady\(nowMs\)/,
  );
});

test('ProductStatus and command rejection share the content mapping pending policy', () => {
  assert.match(
    functionBlock('productStatusPayload'),
    /contentEvidenceReady: robotContentEvidenceMappingReady\(nowMs\)/,
  );
  assert.match(
    server,
    /case 'content-mapping-pending':[\s\S]*?type: 'calibration-command-rejected'[\s\S]*?reason: 'content-mapping-pending'/,
  );
  assert.doesNotMatch(
    commandHandlerBlock('startTimingCalibration'),
    /if \(robotProbeTimingActive\(\) && !robotContentEvidenceMappingReady\(nowMs\)\)/,
    'manual calibration must consume the shared product policy rather than grow an ad-hoc server gate',
  );
});

test('a degraded Robot content transition ends a stuck content calibration instead of waiting for its own timeout', () => {
  // The teardown itself now lives in one revocation transaction, so a degraded
  // transition ends the run by delegating to it rather than by re-spelling the
  // checklist. Leaving the run alive would let Mic evidence keep growing
  // against quarantined backing PCM until the calibration timeout.
  assert.match(
    server,
    /onDegraded: \(status\) => \{[\s\S]*?revokeRobotContentMapping\(\{[\s\S]*?could not be verified\./,
  );
  assert.match(
    functionBlock('revokeRobotContentMapping'),
    /if \(calibration\.collecting\) calibration\.fail\(reason\)/,
    'the revocation transaction is what ends a run that can no longer be completed',
  );
});