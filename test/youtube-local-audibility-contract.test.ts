import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../public/youtube-local-audibility.js', import.meta.url), 'utf8');

test('Take review local-audibility adapter loads before the YouTube owner module', () => {
  const adapterIndex = index.indexOf('/youtube-local-audibility.js');
  const youtubeIndex = index.indexOf('/youtube.js');
  assert.ok(adapterIndex >= 0, 'local audibility adapter must be loaded on Live');
  assert.ok(youtubeIndex > adapterIndex, 'adapter must be installed before youtube.js can construct the player');
});

test('Take review mutes only local YouTube audibility without mutating the shared timeline', () => {
  assert.match(adapter, /relay-take-review-playback/);
  assert.match(adapter, /relay:playback-view/);
  assert.match(adapter, /player\.mute\(\)/);
  assert.match(adapter, /if \(reviewActive\)[\s\S]*restoreAudible = true;[\s\S]*return undefined;/);
  assert.match(adapter, /playbackRole !== 'holder'/);
  assert.match(adapter, /player\.unMute\(\)/);

  for (const forbidden of ['pauseVideo', 'playVideo', 'seekTo', 'loadVideoById', 'cueVideoById']) {
    assert.equal(adapter.includes(forbidden), false, `Take review audibility must not own ${forbidden}`);
  }
});

test('Room sound first paint uses the canonical product wording instead of legacy Adjust copy', () => {
  assert.match(index, /id="local-listen-label" class="section-label">Room sound<\/span>/);
  assert.match(index, /<span>This device only<\/span>/);
  assert.match(index, /<strong>Volume<\/strong>/);
  assert.doesNotMatch(index, /id="local-listen-label"[^>]*data-i18n="adjust\.thisPhone"/);
  assert.doesNotMatch(index, /<strong[^>]*data-i18n="adjust\.listenVolume"/);
});
