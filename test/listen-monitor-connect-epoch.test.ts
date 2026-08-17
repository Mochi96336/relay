import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listenSource = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');

test('Listen retires an opening monitor socket when transport authority changes', () => {
  assert.match(listenSource, /let pendingSocket = null;/);
  assert.match(listenSource, /let transportEpoch = 0;/);
  assert.match(
    listenSource,
    /function closeTransport\(\)[\s\S]*transportEpoch \+= 1;[\s\S]*const opening = pendingSocket;[\s\S]*pendingSocket = null;[\s\S]*opening\.close\(\)/,
  );
  assert.match(
    listenSource,
    /async function connect\(\)[\s\S]*const connectEpoch = transportEpoch;[\s\S]*pendingSocket = next;[\s\S]*if \(pendingSocket === next\) pendingSocket = null;[\s\S]*if \(connectEpoch !== transportEpoch \|\| !transportEnabled \|\| effectiveMuted\(\) \|\| !audioReady\(\)\) \{\s*next\.close\(\);/,
  );
});

test('Listen cannot leave two accepted monitor sockets alive after overlapping connects', () => {
  assert.match(
    listenSource,
    /const previous = socket;\s*socket = next;\s*if \(previous && previous !== next\) \{\s*try \{ previous\.close\(\); \} catch \{\}/,
  );
  assert.match(
    listenSource,
    /next\.addEventListener\('message',[\s\S]*socket !== next \|\| connectEpoch !== transportEpoch/,
  );
});
