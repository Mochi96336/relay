import assert from 'node:assert/strict';
import test from 'node:test';

import {
  functionCode,
  hasFunction,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const fixtureText = `
function alpha(options: { nested: boolean }) {
  // forbiddenRuntime.call() is documentation only.
  const text = "braces in a string do not close the function: }}}";
  return options.nested ? text : '';
}

const coordinator = createThing({
  run: () => alpha({ nested: true }),
  label: 'semi; braces { } stay inside a string',
});

const decoy = 'function ghost() { return false; }';
function beta() { return true; }
`;

const fixture = parseTypeScriptSource(new URL('file:///fixture.ts'), fixtureText);

test('function contracts are declaration-based rather than next-function slices', () => {
  const alpha = functionCode(fixture, 'alpha');
  assert.match(alpha, /return options\.nested/);
  assert.doesNotMatch(alpha, /function beta/);
  assert.doesNotMatch(alpha, /forbiddenRuntime/);
  assert.equal(hasFunction(fixture, 'ghost'), false);
  assert.equal(hasFunction(fixture, 'beta'), true);
});

test('variable initializer contracts balance nested delimiters and ignore strings', () => {
  const initializer = variableInitializerCode(fixture, 'coordinator');
  assert.match(initializer, /^createThing\(\{/);
  assert.match(initializer, /run: \(\) => alpha/);
  assert.match(initializer, /semi; braces \{ \} stay inside a string/);
  assert.doesNotMatch(initializer, /const decoy/);
});

test('whole-source contracts ignore documentation comments without erasing string literals', () => {
  const code = sourceCode(fixture);
  assert.doesNotMatch(code, /forbiddenRuntime/);
  assert.match(code, /braces in a string do not close the function/);
});
