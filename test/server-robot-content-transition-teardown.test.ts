import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('server exposes one whole-transition clear seam distinct from request-only cancellation', () => {
  assert.equal(
    (server.match(/function clearRobotContentTransition\(\)/g) ?? []).length,
    1,
    'whole Robot transition teardown must have one server-owned seam',
  );
  assert.match(
    server,
    /function clearRobotContentTransition\(\) \{\s*relayRobotMapping\.clearTransition\(\);\s*\}/,
  );
  const mapping = parseTypeScriptSource(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url),
    readFileSync(new URL('../src/relay-robot-mapping-orchestration.ts', import.meta.url), 'utf8'));
  assert.match(functionCode(mapping, 'clearTransition'), /dependencies\.transition\.clear\(\)/);
  assert.doesNotMatch(functionCode(mapping, 'clearTransition'), /clearPendingBoundary/);
  assert.doesNotMatch(server, /clearRobotBackingBoundaryRequest|clearBackingBoundaryRequest/);
  assert.match(
    server,
    /robotContentTransitionRuntime\.clearPendingBoundary\(\)/,
    'a seek may still cancel only its outstanding boundary request without retiring the transaction',
  );
});
