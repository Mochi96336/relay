import assert from 'node:assert/strict';
import test from 'node:test';

// Browser-only runtime module; the exported policy functions are intentionally
// exercised in Node without installing its DOM watcher.
import {
  decideRobotPlayerRecovery,
  playerLoadedFromMirrorState,
  reloadBudgetAvailable,
  trimReloadHistory,
} from '../public/robot-player-watchdog.js';

test('robot player recovery waits through transient failures and reloads persistent ones', () => {
  const healthy = {
    hasTimeline: true,
    phonePlaying: true,
    playerError: false,
    playerLoaded: true,
    errorAgeMs: 0,
    notReadyAgeMs: 0,
    stalledForMs: 2_000,
  };
  assert.equal(decideRobotPlayerRecovery(healthy), null);
  assert.equal(decideRobotPlayerRecovery({ ...healthy, playerError: true, errorAgeMs: 4_999 }), null);
  assert.equal(
    decideRobotPlayerRecovery({ ...healthy, playerError: true, errorAgeMs: 5_000 }),
    'youtube-player-error',
  );
  assert.equal(
    decideRobotPlayerRecovery({ ...healthy, playerLoaded: false, notReadyAgeMs: 15_000 }),
    'youtube-player-not-ready',
  );
  assert.equal(
    decideRobotPlayerRecovery({ ...healthy, stalledForMs: 12_000 }),
    'youtube-player-stalled',
  );
});

test('robot player loading state is not confused by UI suffixes', () => {
  assert.equal(playerLoadedFromMirrorState('not loaded'), false);
  assert.equal(playerLoadedFromMirrorState('waiting'), false);
  assert.equal(playerLoadedFromMirrorState('waiting · muted until enabled'), false);
  assert.equal(playerLoadedFromMirrorState('cued · muted until enabled'), true);
  assert.equal(playerLoadedFromMirrorState('playing · following'), true);
});

test('robot player watchdog caps reload loops', () => {
  const now = 1_000_000;
  const history = [now - 60_000, now - 30_000, now - 1_000, now - 400_000];
  assert.deepEqual(trimReloadHistory(history, now), history.slice(0, 3));
  assert.equal(reloadBudgetAvailable(history, now), false);
  assert.equal(reloadBudgetAvailable(history.slice(0, 2), now), true);
});
