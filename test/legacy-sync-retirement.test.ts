import assert from 'node:assert/strict';
import test from 'node:test';

import {
  productionRuntimeSources,
  readRepositoryTextFile,
} from './helpers/source-contract.js';

const html = readRepositoryTextFile('public/index.html');
const production = productionRuntimeSources();
const productionText = production.map((source) => source.text).join('\n');

function assertAbsentFromProduction(pattern: RegExp) {
  for (const source of production) {
    assert.doesNotMatch(source.text, pattern, `${source.path} must not revive retired sync behavior`);
  }
}

test('legacy click sync is fully retired while formal calibration stays intact', () => {
  assertAbsentFromProduction(/start-sync-test|stop-sync-test|test-status/);
  assertAbsentFromProduction(/TEST_BPM|testActive|startLocalClickTrack|stopLocalClickTrack|scheduleClick/);
  assertAbsentFromProduction(/TEST_PREBUFFER_MS|clickMixedFrame|startSyncTest|stopSyncTest/);

  assert.match(productionText, /play-calibration-probe/);
  assert.match(productionText, /start-timing-calibration/);
  assert.match(productionText, /timing-calibration-status/);
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
