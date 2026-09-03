import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classMethodCode,
  functionCode,
  hasFunction,
  importSources,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const fixtureText = `
import type { Example } from './types.js';
import {
  createThing,
} from './thing.js';
import './side-effect.js';
// import { decoy } from './comment-only.js';

function alpha(options: { nested: boolean }) {
  // forbiddenRuntime.call() is documentation only.
  const text = "braces in a string do not close the function: }}}";
  return options.nested ? text : '';
}

class ExampleRuntime {
  run(value: number) {
    // run(999) is documentation, not another method declaration.
    return this.helper(value);
  }

  helper(value: number) {
    const decoy = 'run(123)';
    return value + 1 + decoy.length;
  }
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

test('class method contracts stay at class-member depth and ignore calls or string decoys', () => {
  const run = classMethodCode(fixture, 'ExampleRuntime', 'run');
  assert.match(run, /^run\(value: number\)/);
  assert.match(run, /this\.helper\(value\)/);
  assert.doesNotMatch(run, /helper\(value: number\)/);
  assert.doesNotMatch(run, /run\(999\)/);
});

test('variable initializer contracts balance nested delimiters and ignore strings', () => {
  const initializer = variableInitializerCode(fixture, 'coordinator');
  assert.match(initializer, /^createThing\(\{/);
  assert.match(initializer, /run: \(\) => alpha/);
  assert.match(initializer, /semi; braces \{ \} stay inside a string/);
  assert.doesNotMatch(initializer, /const decoy/);
});

test('import contracts include multiline and side-effect imports while ignoring comments', () => {
  assert.deepEqual(importSources(fixture), [
    './types.js',
    './thing.js',
    './side-effect.js',
  ]);
});

test('whole-source contracts ignore documentation comments without erasing string literals', () => {
  const code = sourceCode(fixture);
  assert.doesNotMatch(code, /forbiddenRuntime/);
  assert.match(code, /braces in a string do not close the function/);
});
