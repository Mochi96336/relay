import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackHandoffFixture, SONG } from './support/playback-handoff-fixture.js';

test('a native rate gesture is observed before an unresolved Play can restore its old rate', async t => {
  const f = await playbackHandoffFixture(t);
  f.send('playback-view', { role: 'holder', room: { videoId: SONG, state: 2 } });
  f.send('room-song-command-apply', {
    commandId: 'initial-load', revision: 1, action: 'load',
    desired: { videoId: SONG, state: 5, positionSeconds: 0, playbackRate: 1, mustApplyPosition: true },
  });
  await f.flush();
  f.clock.advance(250);
  f.send('room-song-command-apply', {
    commandId: 'pending-play', revision: 2, action: 'play',
    desired: { videoId: SONG, state: 1, positionSeconds: 0, playbackRate: 1, mustApplyPosition: false },
  });
  await f.flush();
  const from = f.events.length;
  f.player.rate = 1.5;
  f.player.callbacks.onPlaybackRateChange({ data: 1.5 });
  assert.equal(f.player.rate, 1.5, 'reconciliation must not erase a newer native gesture');
  assert.ok(f.events.slice(from).some(e => e.type === 'relay:room-song-command-intent'
    && e.detail.action === 'rate' && e.detail.playbackRate === 1.5));
});
