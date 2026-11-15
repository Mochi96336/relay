import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startRelay } from './helpers/harness.js';

/**
 * `RELAY_TAKE_DIR` defaults to `takes`, relative to the server's working
 * directory. On this deployment that is the room's real recording library, and
 * the repository checkout is the same tree the phone is served from - so a test
 * that starts a relay and records without naming its own directory writes fake
 * Takes into the user's library, where they appear in the app's history.
 *
 * They are easy to miss because `takes/` is gitignored: nothing in the working
 * tree ever looks dirty. Eighteen zero-length `server-shutdown` artifacts had
 * accumulated from one such test before this guard existed.
 *
 * The guard below only reads test files. On 2026-11-12 an ad-hoc script that
 * drove the harness from the checkout left six more Takes in the library, so
 * the harness itself now gives every server it starts a directory of its own.
 */

/** The text of each `startRelay(...)` argument, parens balanced. */
function startRelayArguments(source: string) {
  const calls: string[] = [];
  const marker = 'startRelay(';
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let depth = 0;
    let index = at + marker.length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === '(') depth += 1;
      else if (source[index] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(at + marker.length, index));
  }
  return calls;
}

/** Whether the argument names a take directory, directly or through a shared env const. */
function namesTakeDirectory(argument: string, source: string) {
  if (argument.includes('RELAY_TAKE_DIR')) return true;
  // `startRelay(env)` and `startRelay({ ...FAST, ... })` both reach the setting
  // through a constant declared in the same file.
  for (const [, identifier] of argument.matchAll(/(?:^|\.{3}|\s)([A-Za-z_$][\w$]*)/g)) {
    const declaration = new RegExp(`const ${identifier}\\s*(?::[^=]+)?=\\s*\\{[\\s\\S]*?\\n\\s*\\}`);
    const match = source.match(declaration);
    if (match && match[0].includes('RELAY_TAKE_DIR')) return true;
  }
  return false;
}

test('every relay a recording test starts names its own take directory', async () => {
  // This file quotes both markers while describing them, so it is not a subject.
  const self = import.meta.url.split('/').pop();
  const entries = (await readdir(new URL('.', import.meta.url)))
    .filter((name) => name.endsWith('.test.ts') && name !== self);

  const offenders: string[] = [];
  for (const name of entries) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    if (!source.includes("'start-take'")) continue;
    const calls = startRelayArguments(source);
    if (calls.length === 0) continue;
    const unisolated = calls.filter((argument) => !namesTakeDirectory(argument, source)).length;
    if (unisolated > 0) offenders.push(`${name} (${unisolated} of ${calls.length})`);
  }

  assert.deepEqual(
    offenders,
    [],
    'these start a relay and record without an isolated take directory, so they '
    + `write into the deployment's real library: ${offenders.join(', ')}`,
  );
});

test('a relay started without a take directory records into a temporary one', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const inherited = process.env.RELAY_TAKE_DIR;
  // A directory in the caller's environment must not be used either.
  process.env.RELAY_TAKE_DIR = path.join(root, 'takes');
  let server;
  try {
    server = await startRelay();
  } finally {
    if (inherited === undefined) delete process.env.RELAY_TAKE_DIR;
    else process.env.RELAY_TAKE_DIR = inherited;
  }
  const directory = server.takeDirectory;
  try {
    assert.ok(path.relative(root, directory).startsWith('..'), `${directory} is inside the checkout`);
    assert.ok(existsSync(directory));
  } finally {
    await server.stop();
  }
  assert.equal(existsSync(directory), false, 'the temporary take directory outlived its server');
});

test('a relay keeps the take directory its test names', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-isolation-'));
  try {
    const server = await startRelay({ RELAY_TAKE_DIR: directory });
    assert.equal(server.takeDirectory, directory);
    await server.stop();
    assert.ok(existsSync(directory), 'a directory the test owns was removed by the harness');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the browser proof launcher isolates its take directory the same way', async () => {
  const source = await readFile(new URL('./browser/support/relay-process.mjs', import.meta.url), 'utf8');
  assert.match(source, /env\.RELAY_TAKE_DIR === undefined\s*\? mkdtempSync\(/);
  assert.match(source, /childEnv\.RELAY_TAKE_DIR = ownTakeDirectory/);
});
