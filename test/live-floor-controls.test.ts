import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Live rehearsal controls form one bottom floor stack', async () => {
  const css = await readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');

  assert.match(css, /min-height:\s*100svh/);
  assert.doesNotMatch(css, /\.live-shell\s*\{[^}]*min-height:\s*100dvh/s);
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
  assert.match(
    takeHistory,
    /recentButton\.textContent = t\('takeHistory\.last', \{[\s\S]*duration: formatDuration\(latest\.artifact\.durationMs\)/,
    'the compact recent recording entry keeps its wording while using the shared i18n provider',
  );
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

test('a transient attention row cannot take the floor from Room sound', async () => {
  const [css, index] = await Promise.all([
    readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  ]);

  // #system-attention is authored after .live-actions, so without an explicit
  // row it is auto-placed *below* the floor stack and pushes Room sound up
  // every time an issue appears and clears.
  assert.match(index, /<footer class="live-actions"[\s\S]*<section id="system-attention"/);
  assert.match(
    css,
    /> #system-attention[^}]*grid-row:\s*4/,
    'attention needs its own row above the floor control stack',
  );
  assert.match(
    css,
    /> \.live-actions \{ grid-row:\s*5; \}/,
    'Room sound stays the last row so it keeps the floor',
  );
  assert.match(
    css,
    /grid-template-rows:\s*max-content max-content minmax\(max-content, 1fr\) max-content max-content;/,
    'the shell grid has to declare the attention row it places',
  );
});

test('the floor stack stays anchored when its optional rows are not rendered', async () => {
  const css = await readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');

  // The stack is built from rows that each disappear on their own terms: the
  // take strip is removed entirely when Record is unavailable and no history
  // exists, and the Mic rail only exists while this phone holds a live mic. A
  // display:none row carries no margin, so anchoring must not live on one of
  // them - that left the Mic rail floating mid-screen with an empty floor.
  assert.match(
    css,
    /> \.mic-actions,\s*\n[^\n]*> #mic-takeover \{\s*\n\s*margin-bottom:\s*auto !important;/,
    'the always-rendered action row above the stack has to claim the free space',
  );
  assert.match(
    css,
    /> \.take-strip[\s\S]*margin-top:\s*auto !important/,
    'the take strip keeps its own anchor for the case where it is rendered',
  );
});
