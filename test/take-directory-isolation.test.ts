import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

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
