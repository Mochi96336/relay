import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const authority = readFileSync(new URL('../src/command-authority.ts', import.meta.url), 'utf8');

test('legacy click sync is fully retired while formal calibration stays intact', () => {
  const retiredProtocol = /start-sync-test|stop-sync-test|test-status/;
  assert.doesNotMatch(html, retiredProtocol);
  assert.doesNotMatch(app, retiredProtocol);
  assert.doesNotMatch(listen, retiredProtocol);
  assert.doesNotMatch(server, retiredProtocol);
  assert.doesNotMatch(authority, retiredProtocol);

  assert.doesNotMatch(app, /TEST_BPM|testActive|startLocalClickTrack|stopLocalClickTrack|scheduleClick/);
  assert.doesNotMatch(server, /TEST_BPM|TEST_PREBUFFER_MS|testActive|clickMixedFrame|startSyncTest|stopSyncTest/);

  assert.match(app, /play-calibration-probe/);
  assert.match(server, /play-calibration-probe/);
  assert.match(server, /start-timing-calibration/);
  assert.match(server, /timing-calibration-status/);
});

test('formal Live does not expose the dead Robot development shortcut', () => {
  assert.match(html, />Technical details</);
  for (const retired of [
    'Robot / development source',
    'Open source',
    'Development tools',
    'class="legacy-tools"',
    'source.html',
  ]) {
    assert.equal(html.includes(retired), false);
  }
});
