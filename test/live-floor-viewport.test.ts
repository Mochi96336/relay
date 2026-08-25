import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mobile Live floor keeps dynamic viewport units out of persistent layout CSS', async () => {
  const [stateCss, layoutCss, viewportCss, liveIa] = await Promise.all([
    readFile(new URL('../public/live-state.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-floor-viewport.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-ia.js', import.meta.url), 'utf8'),
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
  assert.match(viewportCss, /--live-floor-viewport-offset:\s*0px/);
  assert.doesNotMatch(
    viewportCss,
    /\b(?:dvh|lvh)\b/,
    'persistent floor CSS must not move frame-by-frame with dynamic viewport units',
  );

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
    'settled browser chrome changes may move the floor visually but must not reflow it',
  );

  const systemBinding = liveIa.indexOf("openSystem?.addEventListener('click', revealSystem)");
  const floorPresenter = liveIa.indexOf("import('./live-floor-viewport.js')");
  assert.ok(systemBinding >= 0 && floorPresenter > systemBinding,
    'System navigation must bind before the degradable floor viewport presenter');
  assert.doesNotMatch(liveIa, /^import\s/m,
    'the floor viewport presenter must not become a bootstrap-blocking static import');
  assert.match(
    liveIa,
    /import\('\.\/live-floor-viewport\.js'\)\s*\.then\(\(\{ installLiveFloorViewport \}\) => installLiveFloorViewport\(\)\)\s*\.catch/,
    'production Live must install the viewport controller through a degradable dynamic import',
  );
});

test('floor viewport resolution follows only a one-screen unzoomed Live surface', async () => {
  // Production browser modules are plain JS by design; this test executes the
  // real module while keeping the TypeScript-only test harness declaration-free.
  // @ts-expect-error no declaration file for browser production module
  const { resolveLiveFloorViewportOffset } = await import('../public/live-floor-viewport.js');

  assert.equal(resolveLiveFloorViewportOffset({
    mobile: true,
    smallViewportHeight: 844,
    visualViewportHeight: 908,
    shellHeight: 844,
  }), 64);

  assert.equal(resolveLiveFloorViewportOffset({
    mobile: true,
    smallViewportHeight: 667,
    visualViewportHeight: 731,
    shellHeight: 702,
  }), 0, 'overflowing short Live must stay in normal document flow');

  assert.equal(resolveLiveFloorViewportOffset({
    mobile: true,
    smallViewportHeight: 844,
    visualViewportHeight: 620,
    shellHeight: 844,
  }), 0, 'keyboard-sized visual viewport must never push the floor down');

  assert.equal(resolveLiveFloorViewportOffset({
    mobile: true,
    smallViewportHeight: 844,
    visualViewportHeight: 908,
    visualViewportScale: 1.2,
    shellHeight: 844,
  }), 0, 'pinch zoom must not reuse browser-chrome floor positioning');

  assert.equal(resolveLiveFloorViewportOffset({
    mobile: false,
    smallViewportHeight: 844,
    visualViewportHeight: 908,
    shellHeight: 844,
  }), 0, 'desktop layout must not inherit the phone floor policy');
});
