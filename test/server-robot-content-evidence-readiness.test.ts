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
    server,
    /if \(robotProbeTimingActive\(\) && !robotContentEvidenceMappingReady\(nowMs\)\)/,
    'manual calibration must consume the shared product policy rather than grow an ad-hoc server gate',
  );
});

test('a degraded Robot content transition ends a stuck content calibration instead of waiting for its own timeout', () => {
  assert.match(
    server,
    /onDegraded: \(status\) => \{[\s\S]*?timingRuntime\.calibrationKind === 'content'[\s\S]*?&& calibration\.collecting[\s\S]*?calibration\.fail\([\s\S]*?Robot backing content mapping could not be verified\./,
  );
});