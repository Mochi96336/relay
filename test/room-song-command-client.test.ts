import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('visible YouTube controls emit room intent and server apply performs media mutations', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const loadStart = source.indexOf('function loadVideo()');
  const loadEnd = source.indexOf('function trackedRoomCommandId()', loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart, 'load command boundary is missing');
  const loadSection = source.slice(loadStart, loadEnd);
  assert.match(loadSection, /requestRoomSongCommand\(\{ action: 'load'/);
  assert.doesNotMatch(loadSection, /cueVideoById|playVideo\s*\(/, 'user load must not mutate playback before server acceptance');

  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applyEnd = source.indexOf('async function restoreAuthoritativeRoom', applyStart);
  assert.ok(applyStart >= 0 && applyEnd > applyStart, 'server apply helper is missing');
  const applySection = source.slice(applyStart, applyEnd);
  assert.match(applySection, /normalizedDesiredState\(message\.desired\)/);
  assert.match(applySection, /serverMutation\.revision > revision/);
  assert.match(applySection, /serverMutation\.commandId !== commandId/);
  assert.match(applySection, /cueVideoById/);
  assert.match(applySection, /playVideo\s*\(/);
  assert.match(applySection, /pauseVideo\s*\(/);
  assert.match(applySection, /seekTo\s*\(/);
  assert.match(applySection, /setPlaybackRate\s*\(/);
});

test('youtube sync owns command ids, revision and causal predecessor instead of trusting page state', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(sync, /function randomRoomCommandId/);
  assert.match(sync, /let latestRoomCommandId = null/);
  assert.match(sync, /type:\s*'room-song-command'/);
  assert.match(sync, /commandId/);
  assert.match(sync, /expectedRevision/);
  assert.match(sync, /supersedesCommandId/);
  assert.match(sync, /latestRoomCommandId = commandId/);
  assert.match(sync, /type:\s*'room-song-command-status-request'/);
  assert.match(sync, /relay:room-song-command-apply/);
  assert.match(sync, /relay:room-song-command-rejected/);
});

test('native controls can supersede a pending room intent but stable intermediate telemetry stays suppressed', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const requestStart = source.indexOf('function requestRoomSongCommand');
  const requestEnd = source.indexOf('function normalizedDesiredState', requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  const requestSection = source.slice(requestStart, requestEnd);
  assert.doesNotMatch(requestSection, /if \(localCommandPending\) return false/);

  const renderStart = source.indexOf('function renderSnapshot');
  const renderEnd = source.indexOf('function sampleNow', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSection = source.slice(renderStart, renderEnd);
  const mutationIndex = renderSection.indexOf('localMutationForSnapshot(snapshot)');
  const pendingIndex = renderSection.indexOf('if (localCommandPending) return');
  assert.ok(mutationIndex >= 0 && pendingIndex > mutationIndex, 'new native intent must be detected before stable pending telemetry is suppressed');

  const mutationStart = source.indexOf('function localMutationForSnapshot');
  const mutationEnd = source.indexOf('function renderSnapshot', mutationStart);
  const mutationSection = source.slice(mutationStart, mutationEnd);
  assert.match(mutationSection, /snapshotMatchesDesired/);
  assert.doesNotMatch(mutationSection, /if \(activeServerMutation\(\) \|\| pendingHandoff\) return null/);
});

test('terminal command status carries the latest room snapshot for local recovery', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  assert.match(sync, /function withLatestRoom/);
  assert.match(sync, /relay:room-song-command-status', withLatestRoom\(message\)/);
  assert.match(sync, /relay:room-song-command-failed-ack', withLatestRoom\(message\)/);

  const activeStart = source.indexOf('function activeServerMutation()');
  const activeEnd = source.indexOf('function requestRoomSongCommand', activeStart);
  assert.ok(activeStart >= 0 && activeEnd > activeStart);
  const activeSection = source.slice(activeStart, activeEnd);
  assert.match(activeSection, /serverMutation\.source === 'room-command'/);

  const failedStart = source.indexOf("window.addEventListener('relay:room-song-command-failed-ack'");
  const statusStart = source.indexOf("window.addEventListener('relay:room-song-command-status'", failedStart);
  const handoffStart = source.indexOf("window.addEventListener('relay:song-handoff-prepare'", statusStart);
  assert.ok(failedStart >= 0 && statusStart > failedStart && handoffStart > statusStart);
  const terminalSection = source.slice(failedStart, handoffStart);
  assert.match(terminalSection, /restoreAuthoritativeRoom\(detail\.room\)/);
  assert.match(terminalSection, /pendingCommandId !== null/);
  assert.match(terminalSection, /trackedCommandId/);
});

test('room status observation alone never starts playback', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
  const branchStart = sync.indexOf("if (message.type === 'room-song-status')");
  const branchEnd = sync.indexOf("if (message.type === 'room-song-command-status')", branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, 'room status branch is missing');
  const branch = sync.slice(branchStart, branchEnd);
  assert.match(branch, /latestRoomSongStatus = message/);
  assert.doesNotMatch(branch, /room-song-command-apply|playVideo|dispatchRoomCommand/, 'joining/observing room state must not apply or autoplay it');
});
