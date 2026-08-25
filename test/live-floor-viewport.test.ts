import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mobile Live floor follows browser chrome without giving dynamic viewport ownership to layout', async () => {
  const [stateCss, layoutCss, viewportCss] = await Promise.all([
    readFile(new URL('../public/live-state.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-floor-viewport.css', import.meta.url), 'utf8'),
  ]);

  assert.match(
    stateCss,
    /@import url\('\/live-p0-layout\.css'\);\s*@import url\('\/live-floor-viewport\.css'\);/,
    'viewport motion policy must load after the stable floor composition',
  );
  assert.match(layoutCss, /min-height:\s*100svh/);
  assert.doesNotMatch(
    layoutCss,
    /\.live-shell\s*\{[^}]*min-height:\s*100dvh/s,
    'dynamic viewport height must never resize the Live grid',
  );

  assert.match(viewportCss, /--live-floor-viewport-offset:\s*calc\(100dvh - 100svh\)/);
  for (const selector of [
    '.performance-stage > .take-strip',
    'body[data-self-mic="live"] .performance-stage > .mic-live-control',
    '.live-shell > #system-attention',
    '.live-shell > .live-actions',
  ]) {
    assert.ok(viewportCss.includes(selector), `${selector} must share the floor viewport offset`);
  }
  assert.match(
    viewportCss,
    /transform:\s*translateY\(var\(--live-floor-viewport-offset\)\)/,
    'browser chrome changes may move the floor visually but must not reflow it',
  );
});
