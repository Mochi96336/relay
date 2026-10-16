import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { projectFollowerRoom, decideFollowerAction } from '../public/choir-follower-clock.js';

async function fixture() {
  let now = 1000;
  let tick = () => {};
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const events: Array<{ type: string; detail?: any }> = [];
  const listeners = new Map<string, Array<(event: any) => void>>();
  const nodes = new Map<string, any>();
  for (const key of ['.song-stage', '#choir-follower-player', '#choir-follower-status', '#choir-follower-position'])
    nodes.set(key, { hidden: true, dataset: {}, textContent: '', replaceChildren() {} });
  const players: any[] = [];
  class Player {
    state = 5; position = 80; rate = 1; destroyed = false;
    calls: string[] = [];
    constructor(_node: unknown, public config: any) { players.push(this); }
    getCurrentTime() { return this.position; }
    getPlaybackRate() { return this.rate; }
    getPlayerState() { return this.state; }
    cueVideoById() { this.calls.push('cue'); }
    setPlaybackRate() { this.calls.push('rate'); } // Simulate refused rate.
    seekTo(position: number) { this.position = position; this.calls.push('seek'); }
    playVideo() { this.calls.push('play'); }
    pauseVideo() { this.state = 2; this.calls.push('pause'); }
    destroy() { this.destroyed = true; }
  }
  const window = {
    YT: { Player },
    addEventListener(type: string, fn: (event: any) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent(event: any) {
      events.push(event);
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
  };
  const source = (await readFile(new URL('../public/choir-follower.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/, '');
  vm.runInNewContext(source, {
    window, document: { querySelector: (key: string) => nodes.get(key), createElement: () => ({}) },
    performance: { now: () => now }, projectFollowerRoom, decideFollowerAction,
    Event: class { constructor(public type: string) {} },
    CustomEvent: class { detail: any; constructor(public type: string, init: any) { this.detail = init.detail; } },
    setInterval: (fn: () => void) => { tick = fn; },
    setTimeout: (run: () => void, delay: number) => { timers.set(++timerId, { at: now + delay, run }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const emit = (type: string, detail: any) => window.dispatchEvent({ type, detail });
  const room = (rate = 1) => emit('relay:playback-view', {
    role: 'observer', roomReceivedAtMs: now,
    room: { connected: true, handoffState: 'idle', videoId: 'abcdefghijk', revision: 5,
      state: 1, serverTime: 80, playbackRate: rate, duration: 220 },
  });
  room();
  emit('relay-choir-guest-state', { enabled: true });
  await Promise.resolve();
  return {
    players, room, tick: () => tick(), emit,
    active: () => events.filter(event => event.type === 'relay-choir-local-playback').at(-1)?.detail.active ?? false,
    status: () => nodes.get('#choir-follower-status').textContent,
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
      room(); tick(); await Promise.resolve();
    },
  };
}

test('Monitor stays available until B actually plays and returns after video failure', async () => {
  const f = await fixture();
  assert.equal(f.active(), false);
  const p = f.players[0];
  p.config.events.onReady();
  assert.equal(f.active(), false);
  p.state = 1;
  p.config.events.onStateChange({ data: 1 });
  assert.equal(f.active(), true);
  p.config.events.onError();
  assert.equal(f.active(), false);
  assert.equal(p.state, 2);
  p.state = 1;
  p.config.events.onStateChange({ data: 1 });
  assert.equal(f.active(), false);
  assert.equal(p.state, 2);
  f.tick();
  assert.equal(f.status(), 'choir.followerVideoError');
});

test('initialization timeout retries with bounds and ignores retired iframe callbacks', async () => {
  const f = await fixture();
  const retired = f.players[0];
  await f.advance(10_000);
  assert.equal(retired.destroyed, true);
  assert.equal(f.status(), 'choir.followerVideoError');
  assert.equal(f.active(), false);
  await f.advance(5_000);
  assert.equal(f.players.length, 2);
  retired.config.events.onReady();
  retired.config.events.onStateChange({ data: 1 });
  assert.equal(f.active(), false);
  await f.advance(10_000);
  await f.advance(5_000);
  assert.equal(f.players.length, 3);
  await f.advance(10_000);
  await f.advance(60_000);
  assert.equal(f.players.length, 3);
});

test('refused playback rate cannot starve play or seek', async () => {
  const f = await fixture();
  f.room(1.25);
  const p = f.players[0];
  p.config.events.onReady(); // cue
  f.tick(); // rate
  f.tick(); // play despite unchanged rate
  assert.equal(p.calls.filter((call: string) => call === 'rate').length, 1);
  assert.ok(p.calls.includes('play'));
  p.position = 70;
  await f.advance(3_000);
  assert.ok(p.calls.includes('seek'));
});
