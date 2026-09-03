import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callObjectPropertySource,
  topLevelFunctionSource,
  topLevelInitializerSource,
} from './helpers/source-boundary.js';

const sample = String.raw`
// function firstFunction() { fake }
const protocol = createProtocol({
  first: () => {
    const misleading = '}\n  second:';
    const template = ` + "`fake } next: ${'still fake'}`" + `;
    /* second: () => false, */
    return { nested: true };
  },
  second: () => false,
});

function firstFunction() {
  const misleading = '}\nfunction secondFunction(';
  return { nested: () => ({ value: 1 }) };
}

function secondFunction() {
  return false;
}
`;

test('top-level function extraction ignores brace-like strings and comments', () => {
  const block = topLevelFunctionSource(sample, 'firstFunction');
  assert.match(block, /misleading/);
  assert.match(block, /nested/);
  assert.doesNotMatch(block, /^function secondFunction\(\) \{/m);
});

test('top-level initializer extraction returns exactly the named composition call', () => {
  const block = topLevelInitializerSource(sample, 'protocol');
  assert.match(block, /^createProtocol\(\{/);
  assert.match(block, /second: \(\) => false/);
  assert.doesNotMatch(block, /^function firstFunction\(\) \{/m);
});

test('call object property extraction follows structural comma boundaries', () => {
  const block = callObjectPropertySource(sample, 'protocol', 'first');
  assert.match(block, /^first:/);
  assert.match(block, /misleading/);
  assert.match(block, /nested/);
  assert.doesNotMatch(block, /^  second: \(\) => false/m);
});
