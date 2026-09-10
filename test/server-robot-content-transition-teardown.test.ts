import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('server exposes one whole-transition clear seam distinct from request-only cancellation', () => {
  assert.equal(
    (server.match(/function clearRobotContentTransition\(\)/g) ?? []).length,
    1,
    'whole Robot transition teardown must have one server-owned seam',
  );
  assert.match(
    server,
    /function clearRobotContentTransition\(\) \{[\s\S]*?robotContentTransitionRuntime\.clear\(\);[\s\S]*?\n\}/,
  );
  assert.doesNotMatch(server, /clearRobotBackingBoundaryRequest|clearBackingBoundaryRequest/);
  assert.match(
    server,
    /robotContentTransitionRuntime\.clearPendingBoundary\(\)/,
    'a seek may still cancel only its outstanding boundary request without retiring the transaction',
  );
});
