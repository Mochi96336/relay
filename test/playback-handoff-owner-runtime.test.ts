import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackHandoffFixture } from './support/playback-handoff-fixture.js';

test('replacing a muted preparation retains the original audibility for cancellation', async t => {
  const f = await playbackHandoffFixture(t);
  await f.prepare('h1');
  assert.equal(f.player.muted, true);
  await f.prepare('h2');
  f.send('song-handoff-cancelled');
  assert.equal(f.player.muted, false, 'Relay must restore the preference from before its first mute');
});

test('a failed commit mute cannot start the target audibly', async t => {
  const f = await playbackHandoffFixture(t);
  await f.prepare();
  f.player.muted = false; f.player.failMute = true;
  f.commit();
  assert.equal(f.commands.some(command => command[0] === 'play'), false);
  assert.equal(f.events.find(event => event.type === 'relay:song-handoff-failed')?.detail.reason, 'commit-failed');
});

test('preparation stays local and promotion status cannot bypass direct completion', async t => {
  const f = await playbackHandoffFixture(t); await f.prepare();
  f.clock.advance(250);
  assert.equal(f.events.some(event => event.type === 'relay:youtube-telemetry'), false);
  assert.equal(f.events.filter(event => event.type === 'relay:song-handoff-ready').length, 1);
  f.commit(); f.clock.advance(80);
  assert.equal(f.events.some(event => event.type === 'relay:youtube-telemetry'), true);
  f.send('playback-view', { role: 'holder' });
  assert.equal(f.player.muted, true);
  f.send('song-handoff-complete', { handoffId: 'other' }); assert.equal(f.player.muted, true);
  f.send('song-handoff-complete', { handoffId: 'h1' }); assert.equal(f.player.muted, false);
});

for (const failure of ['onError', 'onAutoplayBlocked']) {
  test(`player ${failure} rolls commit back before reporting failure`, async t => {
    const f = await playbackHandoffFixture(t); await f.prepare(); f.commit();
    f.player.callbacks[failure]({ data: 100 });
    assert.equal(f.player.muted, true); assert.equal(f.player.state, 2);
    assert.equal(f.events.filter(event => event.type === 'relay:song-handoff-failed').length, 1);
    f.clock.advance(7000);
    assert.equal(f.events.filter(event => event.type === 'relay:song-handoff-failed').length, 1);
  });
}

test('same-role authoritative timelines realign a committing player before its next proof', async t => {
  const f = await playbackHandoffFixture(t);
  f.send('playback-view', { role: 'preparing' });
  await f.prepare(); f.commit();
  f.send('playback-view', { role: 'preparing', timeline: {
    handoffState: 'committing', handoffId: 'h1', serverTime: 80,
  } });
  assert.equal(f.player.position, 80); assert.equal(f.player.muted, true);
});

test('autoplay recovery persists through telemetry and locale updates until observed PLAYING', async t => {
  const f = await playbackHandoffFixture(t); await f.prepare(); f.commit();
  f.player.pauseOnUnmute = true; f.send('song-handoff-complete', { handoffId: 'h1' });
  f.clock.advance(300);
  assert.equal(f.elements.get('#youtube-note')?.textContent, 'song.handoffAutoplayRecovery');
  f.clock.advance(1500); f.window.dispatchEvent(new Event('relay-locale-changed'));
  assert.equal(f.elements.get('#youtube-note')?.textContent, 'song.handoffAutoplayRecovery');
  f.player.emit(1); f.window.dispatchEvent(new Event('relay-locale-changed'));
  assert.notEqual(f.elements.get('#youtube-note')?.textContent, 'song.handoffAutoplayRecovery');
});

test('late autoplay probe cannot overwrite a newer preparation', async t => {
  const f = await playbackHandoffFixture(t); await f.prepare(); f.commit();
  f.player.pauseOnUnmute = true; f.send('song-handoff-complete', { handoffId: 'h1' });
  const queued = [...f.clock.timers.values()].filter(timer => timer.at === 300).map(timer => timer.callback);
  assert.equal(queued.length, 1);
  await f.prepare('h2');
  for (const callback of queued) callback();
  assert.equal(f.elements.get('#youtube-note')?.textContent, 'song.preparingHandoff');
});

test('prewarm duplicates retain audibility, remain bounded and are consumed by formal preparation', async t => {
  const f = await playbackHandoffFixture(t);
  f.send('playback-view', { role: 'observer', room: {
    videoId: 'dQw4w9WgXcQ', serverTime: 20, state: 1, playbackRate: 1,
  } });
  f.send('playback-prewarm-intent'); await f.flush();
  assert.equal(f.player.muted, true); assert.equal(f.player.position, 20);
  f.clock.advance(10000);
  f.send('playback-prewarm-intent'); await f.flush();
  f.clock.advance(14999); assert.equal(f.player.muted, true);
  f.clock.advance(1);
  assert.equal(f.player.muted, false); assert.equal(f.player.state, 2);
  f.send('playback-prewarm-intent'); await f.flush();
  const loads = f.commands.filter(command => command[0] === 'load').length;
  const expiry = [...f.clock.timers.values()].filter(timer => timer.at === f.clock.now + 15000).map(timer => timer.callback);
  await f.prepare();
  assert.equal(f.commands.filter(command => command[0] === 'load').length, loads, 'matching prepared media is reused');
  for (const callback of expiry) callback();
  assert.equal(f.player.muted, true);
  f.send('song-handoff-cancelled'); assert.equal(f.player.muted, false);
});

async function outgoing(t: Parameters<typeof playbackHandoffFixture>[0]) {
  const f = await playbackHandoffFixture(t); await f.prepare(); f.commit();
  f.send('song-handoff-complete', { handoffId: 'h1' });
  f.send('playback-view', { role: 'holder', transportId: 'tab-a', playbackGeneration: 1,
    timeline: { playbackTransportId: 'tab-a', playbackGeneration: 1, handoffState: 'preparing', handoffId: 'out' } });
  f.send('playback-view', { role: 'observer', transportId: 'tab-a', playbackGeneration: 1,
    timeline: { playbackTransportId: 'tab-b', playbackGeneration: 1, handoffState: 'idle' } });
  return f;
}

test('the outgoing holder stays audible until the matching direct release packet', async t => {
  const f = await outgoing(t);
  assert.equal(f.player.state, 1); assert.equal(f.player.muted, false);
  f.send('song-handoff-release', { handoffId: 'other' }); assert.equal(f.player.state, 1);
  const pauses = f.commands.filter(command => command[0] === 'pause').length;
  f.send('song-handoff-release', { handoffId: 'out' }); assert.equal(f.player.state, 2);
  f.clock.advance(2000);
  assert.equal(f.commands.filter(command => command[0] === 'pause').length, pauses + 1);
});

test('a new target retires the old outgoing fallback before it can pause playback', async t => {
  const f = await outgoing(t);
  const queued = [...f.clock.timers.values()].filter(timer => timer.at === 2000).map(timer => timer.callback);
  assert.equal(queued.length, 1);
  await f.prepare('h2'); f.commit('h2');
  for (const callback of queued) callback();
  assert.equal(f.player.state, 1); assert.equal(f.player.muted, true);
});


test('speculative mute provenance read failure leaves the existing player untouched', async t => {
  const f = await playbackHandoffFixture(t); await f.prepare(); f.commit();
  f.send('song-handoff-complete', { handoffId: 'h1' });
  f.send('playback-view', { role: 'observer', room: {
    videoId: 'dQw4w9WgXcQ', state: 1, serverTime: 40, playbackRate: 1,
  } });
  f.player.isMuted = () => { throw Error('test: unknown mute provenance'); };
  f.commands.length = 0; f.send('playback-prewarm-intent'); await f.flush();
  assert.deepEqual(f.commands, []); assert.equal(f.player.muted, false);
});

test('missing outgoing direct release is contained after the bounded fallback', async t => {
  const f = await outgoing(t);
  f.clock.advance(1999); assert.equal(f.player.state, 1);
  f.clock.advance(1); assert.equal(f.player.state, 2);
});


test('cancelled API loading cannot construct an abandoned iframe or publish its clock', async t => {
  const f = await playbackHandoffFixture(t); f.deferApi(); await f.prepare();
  assert.equal(f.players.length, 0);
  f.send('song-handoff-cancelled'); f.resolveApi(); await f.flush();
  assert.equal(f.players.length, 0); assert.deepEqual(f.events, []);
});

test('only the latest preparation can construct a player after shared API initialization', async t => {
  const f = await playbackHandoffFixture(t); f.deferApi(); await f.prepare('h1');
  await f.prepare('h2', { videoId: '9bZkp7q19f0' }); f.resolveApi(); await f.flush();
  assert.equal(f.players.length, 1); assert.equal(f.player.initialVideoId, '9bZkp7q19f0');
  f.clock.advance(80);
  assert.deepEqual(f.events.filter(event => event.type === 'relay:song-handoff-ready').map(event => event.detail.handoffId), ['h2']);
});

test('retired API initialization failure cannot report against the old handoff', async t => {
  const f = await playbackHandoffFixture(t); f.deferApi(); await f.prepare('h1'); await f.prepare('h2');
  f.rejectApi(); await f.flush();
  assert.deepEqual(f.events.filter(event => event.type === 'relay:song-handoff-failed').map(event => event.detail), [
    { handoffId: 'h2', reason: 'player-unavailable' },
  ]);
});


test('cancelled speculative API loading cannot construct an abandoned iframe', async t => {
  const f = await playbackHandoffFixture(t); f.deferApi();
  f.send('playback-view', { role: 'observer', room: {
    videoId: 'dQw4w9WgXcQ', state: 1, serverTime: 40, playbackRate: 1,
  } });
  f.send('playback-prewarm-intent'); await f.flush(); f.send('playback-prewarm-cancel');
  f.resolveApi(); await f.flush(); assert.equal(f.players.length, 0);
});


test('speculative preparation on an empty surface requests muted media without publishing intent or clock', async t => {
  const f = await playbackHandoffFixture(t);
  f.send('playback-view', { role: 'empty', room: {
    videoId: 'dQw4w9WgXcQ', state: 1, serverTime: 40, playbackRate: 1,
  } });
  f.send('playback-prewarm-intent'); await f.flush(); f.clock.advance(500);
  assert.equal(f.player.muted, true); assert.equal(f.player.position, 40);
  assert.equal(f.commands.some(command => command[0] === 'load'), true);
  assert.equal(f.events.some(event => ['relay:youtube-telemetry', 'relay:room-song-command-intent'].includes(event.type)), false);
});

test('existing holders and preparing targets cannot begin speculative playback', async t => {
  const f = await playbackHandoffFixture(t);
  for (const role of ['holder', 'preparing']) {
    f.send('playback-view', { role, room: {
      videoId: 'dQw4w9WgXcQ', state: 1, serverTime: 40, playbackRate: 1,
    } });
    f.send('playback-prewarm-intent'); await f.flush(); assert.equal(f.players.length, 0);
  }
});
