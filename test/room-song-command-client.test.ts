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

test('latest apply survives player creation without erasing the first post-apply gesture history', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const readyStart = source.indexOf('function handleReady');
  const readyEnd = source.indexOf('function handleStateChange', readyStart);
  assert.ok(readyStart >= 0 && readyEnd > readyStart);
  const readySection = source.slice(readyStart, readyEnd);
  assert.match(readySection, /pendingRoomApply/);
  assert.match(readySection, /applyRoomSongCommand\(pendingRoomApply\)/);
  assert.match(readySection, /finally\(startTelemetry\)/);

  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applyEnd = source.indexOf('async function restoreAuthoritativeRoom', applyStart);
  const applySection = source.slice(applyStart, applyEnd);
  assert.doesNotMatch(applySection, /previousSnapshot = null/);
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
  assert.match(terminalSection, /restoreRoomAfterCommandTerminal\(detail\.room/);
  assert.match(terminalSection, /pendingCommandId !== null/);
  assert.match(terminalSection, /trackedCommandId/);
});

test('terminal handlers ignore unrelated broadcasts and do not restore a chooser observer', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const completeStart = source.indexOf("window.addEventListener('relay:room-song-command-complete'");
  const handoffStart = source.indexOf("window.addEventListener('relay:song-handoff-prepare'", completeStart);
  assert.ok(completeStart >= 0 && handoffStart > completeStart);
  const terminalSection = source.slice(completeStart, handoffStart);

  assert.match(terminalSection, /!trackedCommandId \|\| !commandId \|\| trackedCommandId !== commandId/);
  assert.match(terminalSection, /restoreRoomAfterCommandTerminal/);
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

test('a completed room command keeps suppressing its own arrival until the player converges', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  // Completion says the server saw what it needed, not that this player has
  // finished arriving. Clearing the mutation there left the transition into the
  // commanded state looking like somebody using YouTube's own controls, which
  // became another command, which moved the player again.
  const completeStart = source.indexOf("'relay:room-song-command-complete'");
  assert.ok(completeStart >= 0, 'the completion handler is missing');
  const completeSection = source.slice(completeStart, completeStart + 420);
  assert.match(completeSection, /rememberSettledRoomCommand\(serverMutation\)/);

  const intentStart = source.indexOf('function localMutationForSnapshot');
  const intentEnd = source.indexOf('function renderSnapshot', intentStart);
  assert.ok(intentStart >= 0 && intentEnd > intentStart, 'the intent helper is missing');
  const intentSection = source.slice(intentStart, intentEnd);
  assert.match(
    intentSection,
    /activeSettledRoomCommand\(\)[\s\S]{0,200}snapshotMatchesDesired\(snapshot, settled\)/,
    'only a snapshot matching what the command asked for may be suppressed',
  );

  // A newer command must not inherit the previous one's grace.
  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applySection = source.slice(applyStart, source.indexOf('async function restoreAuthoritativeRoom', applyStart));
  assert.match(applySection, /settledRoomCommand = null;/);
});

test('the apply path moves the player only when the command says to', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applyEnd = source.indexOf('async function restoreAuthoritativeRoom', applyStart);
  const applySection = source.slice(applyStart, applyEnd);

  // Not a distance: the position a command carries is the room's projection,
  // which a player falls behind by buffering alone, so any threshold turns an
  // ordinary play into a seek once the gap grows past it.
  assert.match(applySection, /videoChanged \|\| desired\.mustApplyPosition/);
  assert.doesNotMatch(applySection, /shouldSeekForRoomCommand/);

  assert.match(
    source,
    /mustApplyPosition = desired\.mustApplyPosition !== false/,
    'a payload without the flag must keep positioning, as older ones did',
  );
});
