import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackHandoffFixture, SONG } from './support/playback-handoff-fixture.js';

for (const videoId of [SONG, 'M7lc1UVf-VE']) {
  for (const initiallyMuted of [false, true]) {
    for (const phase of ['preparing', 'committing', 'complete']) {
      test(`late Load cannot replace ${videoId === SONG ? 'same' : 'different'}-video CUED during ${phase} (muted=${initiallyMuted})`, async t => {
        const f = await playbackHandoffFixture(t, { loadDelayMs: 1_000, initiallyMuted });
        f.send('playback-view', { role: 'observer', room: {
          videoId: SONG, state: 1, serverTime: 40, duration: 200, playbackRate: 1,
        } });
        f.send('playback-prewarm-intent'); await f.flush();
        const old = f.player;
        await f.prepare('dormant', { videoId, state: 5, serverTime: 0 });
        f.clock.advance(100);
        const current = f.player;
        assert.equal(current.state, 5, 'the new CUED succeeds before the old Load finishes');
        assert.ok(f.events.some(e => e.type === 'relay:song-handoff-ready'));
        if (phase !== 'preparing') f.commit('dormant', { state: 5, serverTime: 0 });
        if (phase === 'complete') {
          f.send('playback-view', { role: 'holder' });
          f.send('song-handoff-complete', { handoffId: 'dormant' });
        }
        const from = f.events.length;
        f.clock.advance(1_000);
        assert.equal(old.state, 1, 'the old Load really completed after the new CUED');
        assert.deepEqual({ videoId: current.videoId, state: current.state, muted: current.muted },
          { videoId, state: 5, muted: phase !== 'complete' || initiallyMuted });
        assert.notEqual(current, old, 'a new controller cannot share the old media pipeline');
        assert.equal(old.destroyed, true);
        assert.equal(old.muted, true, 'the obsolete pipeline remains inaudible');
        old.callbacks.onError({ target: old, data: 100 });
        old.callbacks.onAutoplayBlocked({ target: old });
        old.callbacks.onReady({ target: old });
        assert.equal(f.events.length, from + f.events.slice(from).filter(e => e.type === 'relay:youtube-telemetry').length,
          'obsolete callbacks must not emit input, failure or readiness for the new player');
        assert.equal(f.player, current);
        if (phase === 'complete') {
          const beforePlay = f.events.length;
          current.emit(1);
          assert.equal(current.state, 1, 'normal native Play must remain available');
          assert.ok(f.events.slice(beforePlay).some(e => e.type === 'relay:room-song-command-intent' && e.detail.action === 'play'));
          // Native media also needs isolation if a new Load arrives before its
          // Play command returns from the server (no adapter request exists yet).
          f.send('room-song-command-apply', { commandId: 'after-native-play', revision: 2, action: 'load',
            desired: { videoId, state: 5, positionSeconds: 0, playbackRate: 1, mustApplyPosition: true } });
          await f.flush();
          assert.notEqual(f.player, current);
          assert.equal(current.destroyed, true);
          assert.equal(f.player.state, 5);
        }
      });
    }
  }
}

test('a moving commit refreshed to CUED isolates the old player and keeps mute provenance', async t => {
  const f = await playbackHandoffFixture(t);
  await f.prepare('natural-end');
  f.commit('natural-end');
  const old = f.player;
  f.commit('natural-end', { state: 5, serverTime: 0 });
  await f.flush(); f.clock.advance(100);
  assert.notEqual(f.player, old);
  assert.equal(old.destroyed, true);
  assert.equal(f.player.state, 5);
  f.commit('natural-end', { state: 5, serverTime: 0 });
  f.send('song-handoff-complete', { handoffId: 'natural-end' });
  assert.equal(f.player.muted, false, 'Relay mute must not become a new user preference');
});

for (const videoId of [SONG, 'M7lc1UVf-VE']) {
  test(`a completed replacement Load keeps its CUED iframe when obsolete ${videoId === SONG ? 'same' : 'different'}-video media arrives`, async t => {
    const f = await playbackHandoffFixture(t, { loadDelayMs: 1_000, initiallyMuted: true });
    f.send('playback-view', { role: 'observer', room: {
      videoId: SONG, state: 1, serverTime: 40, playbackRate: 1,
    } });
    f.send('playback-prewarm-intent'); await f.flush();
    const old = f.player;
    f.send('room-song-command-apply', { commandId: 'replacement-load', revision: 1, action: 'load',
      desired: { videoId, state: 5, positionSeconds: 0, playbackRate: 1, mustApplyPosition: true } });
    await f.flush(); f.clock.advance(250);
    f.send('room-song-command-complete', { commandId: 'replacement-load' });
    const current = f.player;
    f.clock.advance(1_000);
    assert.equal(old.state, 1);
    assert.deepEqual({ videoId: current.videoId, state: current.state, muted: current.muted },
      { videoId, state: 5, muted: true });
    assert.notEqual(current, old);
    assert.equal(old.destroyed, true);
  });
}

test('a repeated prewarm that becomes dormant also retires its old media pipeline', async t => {
  const f = await playbackHandoffFixture(t, { loadDelayMs: 1_000 });
  f.send('playback-view', { role: 'observer', room: { videoId: SONG, state: 1, serverTime: 40, playbackRate: 1 } });
  f.send('playback-prewarm-intent'); await f.flush();
  const old = f.player;
  f.send('playback-view', { role: 'observer', room: { videoId: SONG, state: 0, serverTime: 200, playbackRate: 1 } });
  f.send('playback-prewarm-intent'); await f.flush();
  f.clock.advance(1_000);
  assert.equal(old.state, 1);
  assert.notEqual(f.player, old);
  assert.equal(f.player.state, 5);
  assert.equal(f.player.muted, true);
  f.send('playback-prewarm-cancel');
  assert.equal(f.player.muted, false, 'replacement must preserve the original unmuted preference');
});

for (const prewarm of [false, true]) {
  test(`asynchronous mute on a fresh iframe preserves the original muted preference (prewarm=${prewarm})`, async t => {
    const f = await playbackHandoffFixture(t, { initiallyMuted: true, muteDelayMs: 50 });
    f.send('room-song-command-apply', { commandId: 'old-media', revision: 1, action: 'load',
      desired: { videoId: SONG, state: 1, positionSeconds: 40, playbackRate: 1, mustApplyPosition: true } });
    await f.flush(); f.clock.advance(100);
    f.send('room-song-command-complete', { commandId: 'old-media' });
    const old = f.player;
    f.send('playback-view', { role: 'observer', room: { videoId: SONG, state: 2, serverTime: 40, playbackRate: 1 } });
    if (prewarm) { f.send('playback-prewarm-intent'); await f.flush(); f.clock.advance(100); }
    await f.prepare('muted', { state: 5, serverTime: 40 });
    f.clock.advance(100);
    assert.notEqual(f.player, old);
    f.commit('muted', { state: 5, serverTime: 40 });
    f.send('song-handoff-complete', { handoffId: 'muted' });
    assert.equal(f.player.muted, true);
    assert.equal(f.commands.some(command => command[0] === 'unmute'), false);
  });
}
