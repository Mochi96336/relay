import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const listen = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');

test('a stopped Listen worklet is replaced on the same context and restarts at the live edge', () => {
  assert.match(listen, /addEventListener\?\.\('processorerror', \(\) => \{\s*if \(node === playbackNode\) replacePlaybackNode\('processorerror'\);/,
    'a processorerror retires only the current node');
  assert.match(listen, /if \(node === playbackNode\) lastPlaybackNodeMessageAt = performance\.now\(\);\s*if \(node !== playbackNode \|\| !transportEnabled/,
    'liveness counts every message from the node, before the display gating');
  const replace = listen.slice(listen.indexOf('/** One node install at a time'), listen.indexOf('async function ensureAudioGraph'));
  assert.match(replace, /function installReplacementNode\(context\) \{\s*installNodeOnce\(context\)[\s\S]*restartMonitorAtLiveEdge\(\)/);
  assert.doesNotMatch(replace, /new AudioContext/, 'a phone may need a gesture for a new context');
  assert.match(replace, /playbackNodeReplacements\.length >= 3\) return false;/);
  assert.match(replace, /if \(!takePlaybackNodeReplacement\(\)\) \{\s*offerPlaybackRetry\(\);/,
    'bounded: after three replacements the next press retries');
  assert.match(replace, /function offerPlaybackRetry\(\) \{[\s\S]*render\('start-failed'\)/);
});

test('the liveness watchdog only judges a running context that is being fed', () => {
  const watchdog = listen.slice(listen.indexOf('setInterval(() => {\n    if (!playbackNode'), listen.indexOf('async function ensureAudioGraph'));
  assert.match(watchdog, /!audioRendering\(\) \|\| !transportEnabled \|\| effectiveMuted\(\)\) return;/,
    'a suspended context or muted Listen proves nothing');
  assert.match(watchdog, /now - lastPlaybackPostAt > 1_000\) return;/, 'no audio handed to the node proves nothing');
  assert.match(watchdog, /now - lastPlaybackNodeMessageAt > 3_000\) replacePlaybackNode\('silent'\)/);
});

test('a surviving context gets a new node without loading the worklet module twice', () => {
  assert.match(listen, /if \(playbackModuleContext !== context\) \{\s*await context\.audioWorklet\.addModule\('\/playback-worklet\.js'\);\s*playbackModuleContext = context;/);
  assert.match(listen, /if \(audioContext && !playbackNode\) \{\s*const context = audioContext;\s*await installNodeOnce\(context\);/);
  assert.match(listen, /function installNodeOnce\(context\) \{\s*if \(audioSetupPromise\) return audioSetupPromise;/,
    'a replacement and a press share one install, never two nodes');
});
