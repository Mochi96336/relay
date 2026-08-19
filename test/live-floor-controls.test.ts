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

test('Record and Recordings share the action row without coupling history to Record readiness', async () => {
  const css = await readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');

  assert.match(
    css,
    /\.take-strip\[hidden\]:has\(\.recent-take:not\(\[hidden\]\)\)[\s\S]*display:\s*grid !important/,
    'a real recording history must stay reachable even when #65 hides unavailable Record',
  );
  assert.match(css, /#last-take-toggle::after[\s\S]*content:\s*'Recordings'/);
  assert.match(css, /#last-take-toggle::after[\s\S]*content:\s*'錄音庫'/);
  assert.match(css, /> \.recent-take[\s\S]*grid-column:\s*2 !important/);
});

test('Mic gain is the rail immediately above Room sound', async () => {
  const css = await readFile(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');

  assert.match(
    css,
    /body\[data-self-mic="live"\] \.performance-stage > \.mic-live-control[\s\S]*grid-template-columns:\s*44px minmax\(0, 1fr\) auto/,
  );
  assert.match(css, /\.mic-live-control #mic-gain[\s\S]*height:\s*44px/);
  assert.match(css, /\.live-actions \.local-sound-control[\s\S]*height:\s*44px/);
  assert.match(css, /\.live-actions[\s\S]*margin-top:\s*0 !important/);

  const micRule = css.lastIndexOf('.performance-stage > .mic-live-control');
  const roomRule = css.lastIndexOf('.live-actions');
  assert.ok(micRule >= 0 && roomRule > micRule, 'Mic rail should be authored before the bottom Room sound row');
});
