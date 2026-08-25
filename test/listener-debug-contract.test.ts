import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const debugSource = readFileSync(new URL('../public/listener-debug.js', import.meta.url), 'utf8');

test('listener debug observer installs before production Listen and only activates explicitly', () => {
  const debugIndex = indexSource.indexOf('src="/listener-debug.js"');
  const listenIndex = indexSource.indexOf('src="/listen.js"');
  assert.ok(debugIndex >= 0, 'Live page must load the listener debug observer');
  assert.ok(listenIndex > debugIndex, 'observer must install before Listen creates browser audio resources');

  assert.match(debugSource, /new URLSearchParams\(location\.search\)\.get\('audioDebug'\) === '1'/);
  assert.match(debugSource, /if \(debugEnabled\) \{/);
  assert.match(debugSource, /async function reportSilent\(\)/);
  assert.match(debugSource, /button\.addEventListener\('click', async \(\) => \{[\s\S]*await reportSilent\(\)/);
  const fetchCalls = debugSource.match(/\bfetch\s*\(/g) ?? [];
  assert.equal(fetchCalls.length, 1, 'debug observer may only upload on the explicit incident-report path');
  assert.doesNotMatch(debugSource, /localStorage/);
  assert.doesNotMatch(debugSource, /sessionStorage/);
});

test('listener debug observer stores only evidence metadata, never PCM payloads', () => {
  assert.match(debugSource, /monitorFrameCount \+= 1/);
  assert.match(debugSource, /lastMonitorFrameAt = now\(\)/);
  assert.match(debugSource, /byteLength: event\.data\.byteLength/);
  assert.doesNotMatch(debugSource, /recordSnapshot\([^)]*event\.data/);
  assert.doesNotMatch(debugSource, /recordEvent\([^)]*pcm:/i);
});

test('listener debug faults cover transport, starvation, lifecycle and acoustic-control seams', () => {
  assert.match(debugSource, /function disconnectMonitor\(\)/);
  assert.match(debugSource, /function dropPcm\(ms = 3_000\)/);
  assert.match(debugSource, /function interruptAudio\(ms = 2_000\)/);
  assert.match(debugSource, /function silenceOutput\(ms = 3_000\)/);
  assert.match(debugSource, /window\.__relayListenerDiagnostics = \{/);
  assert.match(debugSource, /event\.stopImmediatePropagation\(\)/);
});
