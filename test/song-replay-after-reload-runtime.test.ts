import assert from 'node:assert/strict';
import test from 'node:test';
import { playbackHandoffFixture, SONG } from './support/playback-handoff-fixture.js';

for (const buffers of [false, true]) {
  test(`native Replay after a dormant reload sends Play${buffers ? ' through BUFFERING' : ''}`, async t => {
    const f = await playbackHandoffFixture(t);
    const view = (generation: number) => f.send('playback-view', {
      role: 'holder',
      room: { videoId: SONG, state: 0, serverTime: 200, duration: 200, playbackRate: 1 },
      timeline: { videoId: SONG, state: 0, serverTime: 200, playbackRate: 1,
        handoffState: 'idle', playbackLeaderParticipantId: 'participant-a',
        playbackTransportId: 'playback-tab-a', playbackGeneration: generation },
      transportId: 'playback-tab-a', playbackGeneration: 2,
    });
    view(1); await f.flush(); f.clock.advance(250);
    assert.equal(f.player.state, 5);
    assert.equal(f.player.position, 0);
    const proof = f.events.find(e => e.type === 'relay:youtube-telemetry');
    assert.equal(proof?.detail.state, 5);
    assert.equal(proof?.detail.currentTime, 0, 'setup readings are distinct from the logical room end');
    view(2); // The server accepted the cued controller, retaining ENDED separately.
    const from = f.events.length;
    if (buffers) f.player.emit(3);
    f.player.emit(1);
    f.clock.advance(1000);
    const commands = f.events.slice(from).filter(e => e.type === 'relay:room-song-command-intent');
    assert.deepEqual(commands.map(e => e.detail.action), ['play']);
    assert.equal(f.player.state, 1, 'the retired restore must not overwrite native Play');
  });
}
