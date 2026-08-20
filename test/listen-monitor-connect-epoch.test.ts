import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listenSource = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');

test('Listen retires an opening monitor socket when transport authority changes', () => {
  assert.match(listenSource, /let pendingSocket = null;/);
  assert.match(listenSource, /let transportEpoch = 0;/);
  assert.match(
    listenSource,
    /function abandonTransportConnection\(\)[\s\S]*transportEpoch \+= 1;[\s\S]*const opening = pendingSocket;[\s\S]*pendingSocket = null;[\s\S]*opening\.close\(\)/,
  );
  assert.match(
    listenSource,
    /function closeTransport\(\)[\s\S]*transportEnabled = false;[\s\S]*abandonTransportConnection\(\)/,
    'explicit shutdown must revoke transport intent and abandon any opening or active connection',
  );
  assert.match(
    listenSource,
    /async function connect\(\)[\s\S]*const connectEpoch = transportEpoch;[\s\S]*pendingSocket = next;[\s\S]*if \(pendingSocket === next\) pendingSocket = null;[\s\S]*if \(connectEpoch !== transportEpoch \|\| !transportEnabled \|\| !monitorTransportWanted\(\)\) \{\s*next\.close\(\);/,
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

test('Listen exposes local playback buffer health without adding product UI coupling', () => {
  assert.match(
    listenSource,
    /function publishListenHealth\(health\)[\s\S]*window\.relayListenHealth = detail;[\s\S]*new CustomEvent\('relay-listen-health', \{ detail \}\)/,
  );
  assert.match(
    listenSource,
    /event\.data\?\.type === 'health'[\s\S]*publishListenHealth\(event\.data\);/,
  );
});
