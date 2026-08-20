import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Live rehearsal controls form one bottom floor stack', async () => {
  const css = await readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');

  assert.match(css, /min-height:\s*100dvh/);
  assert.match(
    css,
    /grid-template-rows:\s*max-content max-content minmax\(max-content, 1fr\) max-content/,
  );
  assert.match(css, /> \.take-strip[\s\S]*margin-top:\s*auto !important/);
  assert.match(css, /> \.take-strip[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto !important/);
});

test('Record and the original recent recording control share the action row without coupling history to Record readiness', async () => {
  const [css, liveIa, index, takeHistory] = await Promise.all([
    readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-ia.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/take-history.js', import.meta.url), 'utf8'),
  ]);

  assert.match(
    index,
    /<section class="take-strip"[\s\S]*?<div id="last-take"[\s\S]*?<\/section>/,
    'recording history must start inside the recording action row',
  );
  assert.doesNotMatch(
    liveIa,
    /insertBefore\(lastTake|append(?:Child)?\(lastTake/,
    'Live IA must not move recording history out of the action row expected by the layout',
  );
  assert.match(
    css,
    /\.take-strip\[hidden\]:has\(\.recent-take:not\(\[hidden\]\)\)[\s\S]*display:\s*grid !important/,
    'a real recording history must stay reachable even when Record is unavailable',
  );
  assert.doesNotMatch(css, /#last-take-toggle::after|font-size:\s*0/);
  assert.match(takeHistory, /`Last take · \$\{formatDuration/);
  assert.match(takeHistory, /`上一段錄音 · \$\{formatDuration/);
  assert.match(css, /> \.recent-take[\s\S]*grid-column:\s*2 !important/);
});

test('Mic gain is the rail immediately above Room sound', async () => {
  const [css, liveIa] = await Promise.all([
    readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/live-ia.js', import.meta.url), 'utf8'),
  ]);

  assert.match(
    css,
    /body\[data-self-mic="live"\] \.performance-stage > \.mic-live-control[\s\S]*grid-template-columns:\s*44px minmax\(0, 1fr\) auto/,
  );
  assert.match(css, /\.mic-live-control #mic-gain[\s\S]*height:\s*44px/);
  assert.match(css, /\.live-actions \.local-sound-control[\s\S]*height:\s*44px/);
  assert.match(css, /\.live-actions[\s\S]*margin-top:\s*0 !important/);
  assert.match(
    liveIa,
    /relay-microphone-local-state[\s\S]*micLiveControl\.open = event\.detail\?\.active === true/,
    'the fixed Mic rail must be open while this phone owns the live microphone',
  );
  assert.doesNotMatch(
    liveIa,
    /event\.key[^\n]*Escape[\s\S]{0,180}micLiveControl\.open = false/,
    'Escape must not close a fixed Mic rail that has no reopen affordance',
  );

  const micRule = css.lastIndexOf('.performance-stage > .mic-live-control');
  const roomRule = css.lastIndexOf('.live-actions');
  assert.ok(micRule >= 0 && roomRule > micRule, 'Mic rail should be authored before the bottom Room sound row');
});
