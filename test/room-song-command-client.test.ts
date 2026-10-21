import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { playbackHandoffFixture, SONG } from './support/playback-handoff-fixture.js';

test('load remains an intent until the server authorizes the player mutation', async t => {
  const f = await playbackHandoffFixture(t);
  f.elements.get('#youtube-url')!.value = SONG;
  f.elements.get('#load-youtube')!.dispatchEvent(new Event('click'));
  assert.equal(f.commands.length, 0);
  assert.equal(f.events.find(e => e.type === 'relay:room-song-command-intent')?.detail.action, 'load');
  f.send('room-song-command-apply', {
    commandId: 'server-load', revision: 1, action: 'load',
    desired: { videoId: SONG, positionSeconds: 0, state: 5, playbackRate: 1, mustApplyPosition: true },
  });
  await f.flush();
  assert.equal(f.player.state, 5);
  assert.ok(f.commands.some(c => c[0] === 'cue'));
  assert.equal(f.commands.some(c => c[0] === 'play'), false);
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

test('native controls can supersede a pending room intent but stable command effects stay suppressed', async () => {
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
  const mutationIndex = renderSection.indexOf('localMutationsForSnapshot(snapshot)');
  const pendingIndex = renderSection.indexOf('if (localCommandPending) return');
  assert.ok(mutationIndex >= 0 && pendingIndex > mutationIndex, 'new native intent must be detected before stable pending telemetry is suppressed');

  const mutationStart = source.indexOf('function localMutationsForSnapshot');
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

test('terminal command status carries the latest room snapshot for real rollback', async () => {
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

test('client and server share convergence instead of a timed settled-command grace', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  assert.match(source, /roomSongCommandConvergence/);
  assert.match(source, /roomSongCommandLocalDeltaEvidence/);
  assert.doesNotMatch(source, /SETTLED_ROOM_COMMAND_MS|settledRoomCommand|rememberSettledRoomCommand|activeSettledRoomCommand/);

  const completeStart = source.indexOf("window.addEventListener('relay:room-song-command-complete'");
  assert.ok(completeStart >= 0, 'the completion handler is missing');
  const completeSection = source.slice(completeStart, completeStart + 520);
  assert.match(completeSection, /serverMutation\?\.commandId === commandId\) serverMutation = null/);
  assert.doesNotMatch(completeSection, /setTimeout|rememberSettled/);
});

test('a state-only command ignores room position but a large native jump still escapes as Seek', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const convergenceStart = source.indexOf('function snapshotConvergence');
  const convergenceEnd = source.indexOf('function snapshotMatchesDesired', convergenceStart);
  assert.ok(convergenceStart >= 0 && convergenceEnd > convergenceStart);
  const convergenceSection = source.slice(convergenceStart, convergenceEnd);
  assert.match(convergenceSection, /mutation\.desired\.mustApplyPosition !== false/);
  assert.match(convergenceSection, /roomSongCommandLocalDeltaEvidence/);

  const mutationStart = source.indexOf('function localMutationsForSnapshot');
  const mutationEnd = source.indexOf('function renderSnapshot', mutationStart);
  const mutationSection = source.slice(mutationStart, mutationEnd);
  const seekIndex = mutationSection.indexOf("mutations.push({ action: 'seek'");
  const stateIndex = mutationSection.indexOf('if (snapshot.state !== snapshot.previousState)');
  assert.ok(seekIndex >= 0 && stateIndex > seekIndex, 'a simultaneous large jump must not be hidden behind Play/Pause');
});

test('state-only clock correction authority comes from an observed command transition, not elapsed command age', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const convergenceStart = source.indexOf('function roomSongCommandTransitionsObserved');
  const convergenceEnd = source.indexOf('function snapshotMatchesDesired', convergenceStart);
  assert.ok(convergenceStart >= 0 && convergenceEnd > convergenceStart, 'command clock provenance wiring is missing');
  const convergenceSection = source.slice(convergenceStart, convergenceEnd);
  assert.match(convergenceSection, /isNewPlayIntent\(snapshot\)/);
  assert.match(convergenceSection, /commandTransition/);
  assert.match(convergenceSection, /correctionDebtSeconds/);
  assert.match(convergenceSection, /roomSongCommandLocalDeltaEvidence/);

  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applyEnd = source.indexOf('async function restoreAuthoritativeRoom', applyStart);
  const applySection = source.slice(applyStart, applyEnd);
  assert.match(applySection, /correctionDebtSeconds:\s*inheritedMutation\?\.correctionDebtSeconds \?\? 0/);
  assert.match(applySection, /observedCommandTransitions/);
});

test('state-only apply preserves position; explicit seek applies even a small delta', async t => {
  const f = await playbackHandoffFixture(t);
  await f.prepare();
  f.send('song-handoff-cancelled');
  f.player.position = 20;
  const apply = async (id: string, action: string, positionSeconds: number, mustApplyPosition: boolean) => {
    f.send('room-song-command-apply', { commandId: id, revision: id === 'play' ? 1 : 2, action,
      desired: { videoId: SONG, positionSeconds, state: 1, playbackRate: 1, mustApplyPosition } });
    await f.flush();
  };
  const before = f.commands.length;
  await apply('play', 'play', 40, false);
  assert.equal(f.player.position, 20);
  assert.equal(f.commands.slice(before).some(c => c[0] === 'seek'), false);
  await apply('seek', 'seek', 20.1, true);
  assert.equal(f.player.position, 20.1);
  assert.ok(f.commands.some(c => c[0] === 'seek' && c[1] === 20.1));
});


test('a cold Play waits for iframe readiness instead of reporting premature failure', async t => {
  const f = await playbackHandoffFixture(t, { readyDelayMs: 500 });
  f.send('room-song-command-apply', { commandId: 'cold-play', revision: 1, action: 'play',
    desired: { videoId: SONG, positionSeconds: 40, state: 1, playbackRate: 1, mustApplyPosition: true } });
  await f.flush();
  assert.equal(f.commands.length, 0);
  f.clock.advance(500); await f.flush();
  assert.equal(f.player.state, 1);
  assert.equal(f.player.position, 40);
  assert.equal(f.events.some(e => e.type === 'relay:room-song-command-failed'), false);
});

test('retired room commands cannot create an iframe when a delayed API finally loads', async t => {
  const f = await playbackHandoffFixture(t); f.deferApi();
  f.send('room-song-command-apply', { commandId: 'retired-load', revision: 1, action: 'load',
    desired: { videoId: SONG, positionSeconds: 0, state: 5, playbackRate: 1, mustApplyPosition: true } });
  await f.flush();
  f.send('room-song-command-failed-ack', { commandId: 'retired-load', room: {} });
  f.resolveApi(); await f.flush();
  assert.equal(f.players.length, 0);
});


test('a converged apply cannot override a native Pause while its server acknowledgment is pending', async t => {
  const f = await playbackHandoffFixture(t);
  await f.prepare(); f.send('song-handoff-cancelled');
  f.send('playback-view', { role: 'holder' });
  f.send('room-song-command-apply', { commandId: 'pending-play', revision: 1, action: 'play',
    desired: { videoId: SONG, positionSeconds: 40, state: 1, playbackRate: 1, mustApplyPosition: false } });
  await f.flush(); f.clock.advance(250);
  assert.equal(f.player.state, 1);
  const from = f.events.length;
  f.player.emit(2);
  assert.equal(f.player.state, 2);
  assert.ok(f.events.slice(from).some(e => e.type === 'relay:room-song-command-intent' && e.detail.action === 'pause'));
});
