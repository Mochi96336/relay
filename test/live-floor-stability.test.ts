import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Safari Live floor keeps one stable small-viewport authority', async () => {
  const [layoutCss, stateCss, liveIa] = await Promise.all([
    readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-state.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-ia.js', import.meta.url), 'utf8'),
  ]);

  const shellBlock = layoutCss.match(/html body \.live-shell\s*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(shellBlock, /min-height:\s*100svh;/,
    'persistent Live layout must use the stable small viewport');
  assert.doesNotMatch(shellBlock, /\b(?:100dvh|100lvh)\b/,
    'dynamic or large viewport units must not own persistent Live height');
  assert.doesNotMatch(shellBlock, /position:\s*fixed/,
    'the Live shell stays in normal document flow rather than fixed positioning');

  assert.equal(stateCss.includes('live-floor-viewport'), false,
    'Live CSS must not reintroduce a browser-chrome floor-motion layer');
  assert.equal(liveIa.includes('live-floor-viewport'), false,
    'Live bootstrap must not install a viewport floor controller');
  assert.doesNotMatch(liveIa, /\bvisualViewport\b/,
    'Safari browser chrome must not become Live floor authority through VisualViewport');
  assert.doesNotMatch(layoutCss, /--live-floor-viewport-offset|translateY\(var\(--live-floor-viewport-offset\)\)/,
    'persistent floor controls must remain in layout flow without viewport translation');
});
