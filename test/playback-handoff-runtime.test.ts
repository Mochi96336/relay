import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackHandoffFixture, SONG } from './support/playback-handoff-fixture.js';

test('runtime preserves prewarm mute provenance and requires PLAYING before handoff ready', async t => {
  const f = await playbackHandoffFixture(t);
  f.send('playback-view', { role: 'observer', room: {
    videoId: SONG, state: 1, serverTime: 10, playbackRate: 1,
  } });
  f.send('playback-prewarm-intent'); await f.flush();
  assert.equal(f.player.muted, true, 'first prewarm must mute the local media request');
  f.send('playback-prewarm-intent'); await f.flush();
  assert.equal(f.player.muted, true);
  f.send('playback-prewarm-cancel');
  assert.equal(f.player.muted, false, 'cancel restores the original audible state');
  assert.equal(f.commands.filter(command => command[0] === 'unmute').length, 1);

  await f.prepare('handoff-runtime', { serverTime: 12 });
  f.player.buffer = 0.9; f.player.emit(3);
  const ready = () => f.events.filter(event => event.type === 'relay:song-handoff-ready');
  assert.equal(ready().length, 0, 'BUFFERING with non-zero loaded fraction cannot prove readiness');
  f.player.position = 12.1; f.player.emit(1);
  assert.equal(ready().length, 1, 'PLAYING on the exact video announces readiness once');
});
