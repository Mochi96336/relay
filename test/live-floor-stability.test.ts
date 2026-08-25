import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Safari Live floor keeps one stable small-viewport authority', async () => {
  const [layoutCss, stateCss, liveIa] = await Promise.all([
    readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-state.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-ia.js', import.meta.url), 'utf8'),
  ]);

  const shellBlocks = [...layoutCss.matchAll(/html body \.live-shell\s*\{[^}]*\}/gs)]
    .map((match) => match[0]);
  assert.ok(shellBlocks.length > 0, 'Live layout must retain an explicit shell rule');
  assert.ok(shellBlocks.some((block) => /min-height:\s*100svh;/.test(block)),
    'persistent Live layout must use the stable small viewport');
  for (const block of shellBlocks) {
    assert.doesNotMatch(block, /\b(?:100dvh|100lvh)\b/,
      'dynamic or large viewport units must not own persistent Live height');
    assert.doesNotMatch(block, /position:\s*fixed/,
      'the Live shell stays in normal document flow rather than fixed positioning');
  }

  assert.equal(stateCss.includes('live-floor-viewport'), false,
    'Live CSS must not reintroduce a browser-chrome floor-motion layer');
  assert.equal(liveIa.includes('live-floor-viewport'), false,
    'Live bootstrap must not install a viewport floor controller');
  assert.doesNotMatch(liveIa, /\bvisualViewport\b/,
    'Safari browser chrome must not become Live floor authority through VisualViewport');
  assert.doesNotMatch(layoutCss, /--live-floor-viewport-offset|translateY\(var\(--live-floor-viewport-offset\)\)/,
    'persistent floor controls must remain in layout flow without viewport translation');
});
