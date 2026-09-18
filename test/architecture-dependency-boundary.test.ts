import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  readSourceTree,
  staticModuleSpecifiers,
} from './helpers/source-contract.js';

const existingServerToPublicDebt: string[] = [];

function resolvedTarget(sourcePath: string, specifier: string) {
  if (!specifier.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
}

test('server/domain source does not depend on browser static assets', () => {
  const edges: string[] = [];
  for (const source of readSourceTree('src', ['.ts'])) {
    for (const specifier of staticModuleSpecifiers(source)) {
      const target = resolvedTarget(source.path, specifier);
      if (target?.startsWith('public/')) edges.push(`${source.path} -> ${specifier}`);
    }
  }

  assert.deepEqual(
    edges.sort(),
    existingServerToPublicDebt,
    'Shared policy belongs in shared/; do not add src -> public dependencies.',
  );
});

test('browser static modules never depend back on server/domain source', () => {
  const edges: string[] = [];
  for (const source of readSourceTree('public', ['.js'])) {
    for (const specifier of staticModuleSpecifiers(source)) {
      const target = resolvedTarget(source.path, specifier);
      if (target?.startsWith('src/')) edges.push(`${source.path} -> ${specifier}`);
    }
  }

  assert.deepEqual(edges, []);
});
