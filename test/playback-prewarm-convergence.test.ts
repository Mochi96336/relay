import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackHandoffFixture, SONG } from './support/playback-handoff-fixture.js';

for (const [prewarmState, planState] of [[2, 1], [1, 2]]) {
  test(`prewarm ${prewarmState} converges to formal handoff ${planState}`, async t => {
    const f = await playbackHandoffFixture(t);
    f.send('playback-view', { role: 'observer', room: {
      videoId: SONG, state: prewarmState, serverTime: 40, duration: 200, playbackRate: 1,
    } });
    f.send('playback-prewarm-intent'); await f.flush();
    // The iframe may still be paused from a previous interaction when reused.
    f.player.state = prewarmState;
    assert.equal(f.player.state, prewarmState);
    await f.prepare('changed-intent', { serverTime: 40, state: planState });
    f.clock.advance(500);
    assert.equal(f.player.state, planState);
    assert.equal(f.events.filter(e => e.type === 'relay:song-handoff-ready').length, 1);
  });
}
