import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubePlaybackTarget, type TargetOptions } from '../public/youtube-playback-target.js';
import { FakeClock } from './support/fake-clock.js';

const VIDEO = 'dQw4w9WgXcQ';
function fixture() {
  const clock = new FakeClock();
  const commands: unknown[][] = [];
  let target: YouTubePlaybackTarget;
  const player = {
    state: 2, position: 20, rate: 1, videoId: VIDEO,
    getVideoData() { return { video_id: this.videoId }; },
    getPlayerState() { return this.state; }, getCurrentTime() { return this.position; },
    getPlaybackRate() { return this.rate; },
    cueVideoById(input: { videoId: string; startSeconds: number }) {
      commands.push(['cue', input]);
      clock.setTimeout(() => { this.videoId = input.videoId; this.position = 0; this.state = 5; target.observe(); }, 100);
    },
    loadVideoById(input: { videoId: string; startSeconds: number }) {
      commands.push(['load', input]);
      this.state = -1;
      clock.setTimeout(() => { this.videoId = input.videoId; this.position = input.startSeconds; this.state = 1; target.observe(); }, 100);
    },
    seekTo(position: number) { this.position = position; commands.push(['seek', position]); },
    setPlaybackRate(rate: number) {
      commands.push(['rate', rate]);
      clock.setTimeout(() => { this.rate = rate; target.observe(); }, 20);
    },
    playVideo() {
      commands.push(['play']);
      clock.setTimeout(() => { this.state = 1; target.observe(); }, 50);
    },
    pauseVideo() {
      commands.push(['pause']);
      clock.setTimeout(() => { this.state = 2; target.observe(); }, 50);
    },
  };
  return { player, commands, clock, start(state: number, options: TargetOptions = {}) {
    target?.retire();
    target = new YouTubePlaybackTarget(player, { videoId: VIDEO, positionSeconds: 40, state, playbackRate: 1 }, options);
    target.observe();
    return target;
  } };
}

test('reused paused media actively starts, without treating a request as an observation', () => {
  const f = fixture(); const target = f.start(1);
  for (let i = 0; i < 20; i++) target.observe();
  assert.equal(f.player.state, 2);
  assert.deepEqual(f.commands, [['play']]);
  f.clock.advance(50);
  assert.equal(f.player.state, 1);
  assert.equal(f.player.position, 20, 'a state-only command has no seek authority');
});

test('a cold paused target waits for actual PLAYING before requesting Pause once', () => {
  const f = fixture(); const target = f.start(2, { mode: 'load' });
  target.observe();
  assert.equal(f.commands.some(c => c[0] === 'pause'), false);
  f.clock.advance(100);
  for (let i = 0; i < 20; i++) target.observe();
  assert.equal(f.commands.filter(c => c[0] === 'pause').length, 1);
  assert.equal(f.player.state, 1);
  f.clock.advance(50);
  assert.equal(f.player.state, 2);
});

test('a dormant target cues without requesting playback or seeking its setup clock', () => {
  const f = fixture(); const target = f.start(5, { mode: 'cue', seek: true });
  f.clock.advance(100); target.observe();
  assert.equal(f.player.state, 5);
  assert.deepEqual(f.commands.map(c => c[0]), ['cue']);
  assert.equal(f.player.position, 0);
});

test('retiring an attempt prevents delayed state observations from applying further mutations', () => {
  const f = fixture(); const target = f.start(2, { mode: 'load' });
  target.retire(); f.clock.advance(500);
  assert.deepEqual(f.commands.map(c => c[0]), ['load']);
});

test('unreadable playback rate does not prevent a state command', () => {
  const f = fixture(); f.player.getPlaybackRate = () => { throw Error('iframe not readable yet'); };
  f.start(1); f.clock.advance(50);
  assert.equal(f.player.state, 1);
  assert.equal(f.commands.filter(c => c[0] === 'rate').length, 1);
});


test('a retired cue finishing late cannot displace the current load target', () => {
  const f = fixture(); const target = f.start(1, { mode: 'load' });
  f.clock.advance(100);
  assert.equal(f.player.position, 40);
  // YouTube commands already posted to the iframe can finish after retirement.
  f.player.state = 5; f.player.position = 0;
  target.observe(); f.clock.advance(50); target.observe();
  assert.equal(f.player.position, 40);
  assert.equal(f.player.state, 1);
});

test('an explicit seek is not reissued after its asynchronous state transition', () => {
  const f = fixture(); f.player.position = 40;
  const target = f.start(1, { seek: true });
  assert.equal(f.commands.filter(c => c[0] === 'seek').length, 1);
  f.player.state = 3; target.observe();
  f.clock.advance(50); target.observe();
  assert.equal(f.commands.filter(c => c[0] === 'seek').length, 1);
});


test('a reentrant player read cannot seek after the current operation was retired', () => {
  const f = fixture(); let current = true;
  f.player.getCurrentTime = () => { current = false; return 20; };
  f.start(1, { seek: true, isCurrent: () => current });
  assert.deepEqual(f.commands, []);
});


test('observed convergence releases native Pause, rate changes and natural completion', () => {
  const f = fixture(); const target = f.start(1);
  f.clock.advance(50);
  assert.equal(target.converged, true);
  const count = f.commands.length;
  f.player.state = 2; target.observe();
  assert.equal(f.player.state, 2);
  f.player.rate = 1.5; target.observe();
  f.player.state = 0; target.observe();
  assert.equal(f.commands.length, count);
});
