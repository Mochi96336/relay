import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackHandoff, HANDOFF_COMMIT_TIMEOUT_MS, HANDOFF_STALL_REPORT_MS, type HandoffPlayer, type HandoffMutation } from '../public/playback-handoff.js';
import { FakeClock } from './support/fake-clock.js';
import { deferred } from './support/deferred.js';

const VIDEO = 'dQw4w9WgXcQ';
function fixture(ensure: (video: string, current: () => boolean) => Promise<unknown> = async () => {}) {
  const clock = new FakeClock();
  const effects: unknown[][] = [], failures: unknown[][] = [], ready: string[] = [], notes: string[] = [];
  const mutations: HandoffMutation[] = [], stalled: unknown[][] = [];
  let readFails = false, muteFails = false;
  const player = {
    videoId: VIDEO as string | null, state: 1, position: 40, buffer: 0.5, rate: 1, muted: false,
    getVideoData() { return { video_id: this.videoId }; },
    getPlayerState() { if (readFails) throw Error('not ready'); return this.state; },
    getCurrentTime() { return this.position; },
    getVideoLoadedFraction() { return this.buffer; },
    isMuted() { if (readFails) throw Error('unknown mute provenance'); return this.muted; },
    mute() { if (muteFails) throw Error('mute failed'); this.muted = true; effects.push(['mute']); },
    unMute() { this.muted = false; effects.push(['unmute']); },
    loadVideoById(input: { videoId: string; startSeconds: number }) {
      this.videoId = input.videoId; this.position = input.startSeconds; effects.push(['load', input]);
    },
    seekTo(position: number) { this.position = position; effects.push(['seek', position]); },
    setPlaybackRate(rate: number) { this.rate = rate; effects.push(['rate', rate]); },
    playVideo() { this.state = 1; effects.push(['play']); },
    pauseVideo() { this.state = 2; effects.push(['pause']); },
  };
  let currentPlayer: HandoffPlayer | null = player;
  let samples = 0;
  const owner = new PlaybackHandoff({
    getPlayer: () => currentPlayer, ensurePlayer: ensure,
    onMutation: mutation => mutations.push(mutation), onTimelineBoundary: video => effects.push(['boundary', video]),
    onNote: key => notes.push(key), onReady: id => ready.push(id),
    onFailure: (...args) => failures.push(args), onStalled: (...args) => stalled.push(args), sampleNow: () => { samples++; },
    now: () => clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, warn() {},
  });
  const prepare = (id = 'h1', overrides = {}, preparation = {}) => owner.prepare({
    handoffId: id, videoId: VIDEO, targetTime: 40, desiredState: 1, playbackRate: 1, ...overrides,
  }, preparation);
  const commit = (id = 'h1', overrides = {}) => owner.commit({ handoffId: id, serverTime: 41, state: 1, ...overrides });
  return { owner, player, effects, failures, ready, notes, mutations, stalled, clock, prepare, commit,
    get samples() { return samples; },
    setPlayer(value: HandoffPlayer | null) { currentPlayer = value; },
    failReads(value = true) { readFails = value; }, failMute(value = true) { muteFails = value; },
  };
}

test('cold preparation requests media muted, owns its polling and suppresses command telemetry', async () => {
  const f = fixture(); await f.prepare();
  assert.equal(f.owner.pending?.phase, 'preparing');
  assert.deepEqual(f.effects, [['boundary', VIDEO], ['mute'], ['load', { videoId: VIDEO, startSeconds: 40 }], ['rate', 1]]);
  assert.deepEqual(f.mutations, [{ source: 'handoff-prepare', action: 'load', suppressTelemetry: true, expiresAt: 3000 }]);
  assert.equal(f.clock.timers.size, 11, 'ten readiness checks and one stall report');
  assert.equal(f.player.muted, true);
  assert.equal(f.effects.some(effect => effect[0] === 'play'), false);
});

for (const desiredState of [1, 2, 3, 5, 0, -1]) {
  test(`readiness proves exact video, renderable state and buffer for desired ${desiredState}`, async () => {
    const f = fixture(); await f.prepare('h1', { desiredState });
    const expected = [1, 3].includes(desiredState) ? 1 : 2;
    for (const state of [-1, 0, 1, 2, 3, 5]) {
      f.player.state = state; f.player.videoId = 'other-video';
      assert.equal(f.owner.announceReady(), false);
      f.player.videoId = VIDEO; f.player.buffer = 0;
      assert.equal(f.owner.announceReady(), false);
      f.player.buffer = 0.5;
      if (state !== expected) assert.equal(f.owner.announceReady(), false);
    }
    f.player.state = expected;
    assert.equal(f.owner.announceReady(), true);
    assert.equal(f.owner.announceReady(), false);
    assert.deepEqual(f.ready, ['h1']); assert.equal(f.clock.timers.size, 0);
  });
}

test('readiness read failure stays pending and polling reaches the late readiness window', async () => {
  const f = fixture(); await f.prepare(); f.failReads();
  f.clock.advance(11000); assert.deepEqual(f.ready, []);
  f.failReads(false); f.clock.advance(5000);
  assert.deepEqual(f.ready, ['h1']);
});

test('terminal media prepares just before the end and observes PAUSED before readiness', async () => {
  const f = fixture(); await f.prepare('h1', { targetTime: 200, desiredState: 0 });
  assert.equal(f.player.position, 199.75);
  f.owner.observeState(1);
  assert.equal(f.player.state, 2); assert.deepEqual(f.ready, ['h1']);
});

test('matching speculative media is reused with its original mute provenance', async () => {
  const f = fixture(); f.player.muted = true; f.player.position = 40;
  await f.prepare('h1', {}, { reusePreparedPlayer: true, wasMuted: false });
  assert.equal(f.effects.some(effect => effect[0] === 'load' || effect[0] === 'seek'), false);
  f.owner.cancel(); assert.equal(f.player.muted, false);
});

test('a warmed player is corrected to current time and a mismatched video gets a real load', async () => {
  const f = fixture(); f.player.position = 30;
  await f.prepare('h1', {}, { reusePreparedPlayer: true });
  assert.equal(f.effects.some(effect => effect[0] === 'seek' && effect[1] === 40), true);
  f.player.videoId = 'other-video'; f.effects.length = 0;
  await f.prepare('h2', {}, { reusePreparedPlayer: true });
  assert.equal(f.effects.some(effect => effect[0] === 'load'), true);
});

test('mute provenance failure cannot mute, load or claim readiness', async () => {
  const f = fixture(); f.failReads(); await f.prepare();
  assert.equal(f.player.muted, false);
  assert.equal(f.effects.some(effect => ['mute', 'load', 'play'].includes(String(effect[0]))), false);
  assert.deepEqual(f.failures, [['h1', 'prepare-failed']]);
  assert.equal(f.owner.announceReady(), false);
});

for (const initiallyMuted of [false, true]) {
  test(`replacement preparation retains original muted=${initiallyMuted} through cancellation`, async () => {
    const f = fixture(); f.player.muted = initiallyMuted;
    await f.prepare('h1'); await f.prepare('h2'); f.owner.cancel();
    assert.equal(f.player.muted, initiallyMuted); assert.equal(f.owner.pending, null);
    assert.equal(f.clock.timers.size, 0);
  });
}

test('stale ready, commit watchdog and sample callbacks cannot act on a replacement', async () => {
  const f = fixture(); await f.prepare();
  const readyCallbacks = [...f.clock.timers.values()].map(timer => timer.callback);
  f.commit(); const commitCallbacks = [...f.clock.timers.values()].map(timer => timer.callback);
  await f.prepare('h2'); f.effects.length = 0;
  for (const callback of [...readyCallbacks, ...commitCallbacks]) callback();
  assert.deepEqual(f.effects, []); assert.deepEqual(f.failures, []); assert.deepEqual(f.ready, []);
  assert.equal(f.samples, 0); assert.equal(f.owner.pending?.handoffId, 'h2');
});

test('retired async initialization cannot cue or report failure for a newer attempt', async () => {
  const first = deferred<void>(), second = deferred<void>(); const guards: (() => boolean)[] = [];
  const f = fixture(async (video, current) => { guards.push(current); return guards.length === 1 ? first.promise : second.promise; });
  const a = f.prepare('h1'); const b = f.prepare('h2');
  assert.equal(guards[0](), false); assert.equal(guards[1](), true);
  first.reject(Error('retired init')); assert.equal(await a, false); assert.deepEqual(f.failures, []);
  second.resolve(); assert.equal(await b, true);
  assert.equal(f.effects.filter(effect => effect[0] === 'load').length, 1);
});

test('cancelled initialization cannot recreate playback when it resolves late', async () => {
  const initialized = deferred<void>(); const f = fixture(async () => initialized.promise);
  const pending = f.prepare(); f.owner.cancel(); f.effects.length = 0;
  initialized.resolve(); assert.equal(await pending, false); assert.deepEqual(f.effects, []);
});

test('commit accepts only the matching handoff and finite refreshed position', async () => {
  const f = fixture(); await f.prepare(); f.effects.length = 0;
  assert.equal(f.commit('other'), false); assert.equal(f.commit('h1', { serverTime: NaN }), false);
  assert.deepEqual(f.effects, []); assert.equal(f.owner.pending?.phase, 'preparing');
  assert.equal(f.commit(), true);
  assert.equal(f.owner.pending?.phase, 'committing'); assert.equal(f.player.position, 41);
  assert.equal(f.player.muted, true); assert.equal(f.player.state, 1);
  assert.equal(f.mutations.at(-1)?.suppressTelemetry, false);
  assert.equal(f.owner.announceReady(), false);
});

test('an unavailable player rejects commit without consuming preparation', async () => {
  const f = fixture(); await f.prepare(); f.setPlayer(null);
  assert.equal(f.commit(), false); assert.deepEqual(f.failures, [['h1', 'player-not-ready']]);
  assert.equal(f.owner.pending?.phase, 'preparing');
});

test('commit mute failure rolls back before playback starts', async () => {
  const f = fixture(); await f.prepare(); f.failMute(); f.effects.length = 0;
  assert.equal(f.commit(), false); assert.equal(f.effects.some(effect => effect[0] === 'play'), false);
  assert.deepEqual(f.failures, [['h1', 'commit-failed']]); assert.equal(f.owner.pending?.phase, 'preparing');
});

test('commit watchdog is later than server proof expiry and rolls back without seeking stale time', async () => {
  const f = fixture(); await f.prepare(); f.commit(); f.effects.length = 0;
  f.clock.advance(HANDOFF_COMMIT_TIMEOUT_MS - 1);
  assert.deepEqual(f.failures, []); assert.equal(f.owner.pending?.phase, 'committing');
  assert.equal(f.samples, 2);
  f.clock.advance(1); assert.deepEqual(f.failures, [['h1', 'commit-timeout']]);
  assert.equal(f.owner.pending?.phase, 'preparing'); assert.equal(f.player.muted, true);
  assert.equal(f.effects.some(effect => effect[0] === 'seek'), false); assert.equal(f.clock.timers.size, 0);
});

test('rollback publishes failure after parking the player and remains retryable', async () => {
  const f = fixture(); await f.prepare(); f.commit();
  assert.equal(f.owner.rollback('autoplay-blocked'), true);
  assert.equal(f.owner.pending?.phase, 'preparing'); assert.equal(f.player.state, 2); assert.equal(f.player.muted, true);
  assert.equal(f.owner.rollback('duplicate'), false);
  f.commit(); assert.equal(f.owner.pending?.phase, 'committing');
});

test('fresh authoritative realignment advances the muted media clock without resetting the proof deadline', async () => {
  const f = fixture(); await f.prepare(); f.commit(); f.clock.advance(1000);
  assert.equal(f.owner.realign({ handoffState: 'committing', handoffId: 'other', serverTime: 80 }), false);
  f.player.videoId = null;
  assert.equal(f.owner.realign({ handoffState: 'committing', handoffId: 'h1', serverTime: 80 }), false);
  f.player.videoId = VIDEO; f.player.state = 3;
  assert.equal(f.owner.realign({ handoffState: 'committing', handoffId: 'h1', serverTime: 80 }), false);
  f.player.state = 1;
  assert.equal(f.owner.realign({ handoffState: 'committing', handoffId: 'h1', serverTime: 80 }), true);
  assert.equal(f.player.position, 80); assert.equal(f.player.muted, true);
  assert.equal(f.owner.realign({ handoffState: 'committing', handoffId: 'h1', serverTime: 80.5 }), false);
  f.clock.advance(5500); assert.deepEqual(f.failures, [['h1', 'commit-timeout']]);
});

for (const muted of [false, true]) {
  test(`only matching direct completion restores original muted=${muted}`, async () => {
    const f = fixture(); f.player.muted = muted; await f.prepare(); f.commit();
    assert.equal(f.owner.complete('other'), null); assert.equal(f.player.muted, true);
    const completed = f.owner.complete('h1');
    assert.deepEqual(completed, { desiredState: 1, unmuteRequested: !muted });
    assert.equal(f.player.muted, muted); assert.equal(f.owner.pending, null);
    assert.equal(f.clock.timers.size, 0); assert.equal(f.owner.complete('h1'), null);
  });
}

test('completion and cancellation never unmute a replacement player', async () => {
  for (const terminal of ['complete', 'cancel']) {
    const f = fixture(); await f.prepare();
    const replacement = { ...f.player, muted: true }; f.setPlayer(replacement);
    if (terminal === 'complete') f.owner.complete('h1'); else f.owner.cancel();
    assert.equal(replacement.muted, true);
  }
});

test('reentrant cancellation during mute cannot load media after retirement', async () => {
  const f = fixture(); const mute = f.player.mute.bind(f.player);
  f.player.mute = () => { mute(); f.owner.cancel(); };
  await f.prepare();
  assert.equal(f.owner.pending, null); assert.equal(f.player.muted, false);
  assert.equal(f.effects.some(effect => effect[0] === 'load'), false);
});

test('reentrant replacement while cancelling cannot restore audibility over the new preparation', async () => {
  const f = fixture(); await f.prepare();
  const pause = f.player.pauseVideo.bind(f.player); let replacement: Promise<boolean> | null = null;
  f.player.pauseVideo = () => { pause(); replacement = f.prepare('h2'); };
  f.owner.cancel(); await replacement;
  assert.equal(f.owner.pending?.handoffId, 'h2'); assert.equal(f.player.muted, true);
  f.player.pauseVideo = pause; f.owner.cancel(); assert.equal(f.player.muted, false);
});


test('queued timers from a previous commit cannot time out a retry of the same handoff', async () => {
  const f = fixture(); await f.prepare(); f.commit();
  const previous = [...f.clock.timers.values()].map(timer => timer.callback);
  f.owner.rollback('autoplay-blocked'); f.commit(); f.failures.length = 0;
  for (const callback of previous) callback();
  assert.deepEqual(f.failures, []); assert.equal(f.samples, 0);
  assert.equal(f.owner.pending?.phase, 'committing');
});

test('unmuted or unowned media cannot prove preparation readiness', async () => {
  const f = fixture(); await f.prepare();
  f.player.muted = false; assert.equal(f.owner.announceReady(), false);
  const replacement = { ...f.player, muted: true };
  f.setPlayer(replacement); assert.equal(f.owner.announceReady(), false);
  assert.deepEqual(f.ready, []);
});

test('commit mutes before loading a mismatched video', async () => {
  const f = fixture(); await f.prepare(); f.player.muted = false; f.player.videoId = 'different';
  const load = f.player.loadVideoById.bind(f.player);
  f.player.loadVideoById = input => { assert.equal(f.player.muted, true); load(input); };
  assert.equal(f.commit(), true);
});

test('failed provenance reads leave untouched media alone even on cancellation', async () => {
  const f = fixture(); f.failReads(); await f.prepare(); f.effects.length = 0;
  f.owner.cancel(); assert.deepEqual(f.effects, []); assert.equal(f.player.muted, false);
});


test('a reused ENDED player seeks just inside media even within ordinary seek tolerance', async () => {
  const f = fixture(); f.player.position = 200; f.player.state = 0;
  await f.prepare('h1', { desiredState: 0, targetTime: 200 }, { reusePreparedPlayer: true });
  assert.equal(f.player.position, 199.75);
  assert.equal(f.effects.some(effect => effect[0] === 'seek'), true);
});


test('repeated realignment bounds pending samples without renewing the commit deadline', async () => {
  const f = fixture(); await f.prepare(); f.commit();
  const obsoleteSamples = [...f.clock.timers.values()].filter(timer => timer.at < 6500).map(timer => timer.callback);
  for (let index = 0; index < 100; index++) {
    assert.equal(f.owner.realign({ handoffState: 'committing', handoffId: 'h1', serverTime: 80 + index }), true);
    assert.equal(f.clock.timers.size, 3);
  }
  for (const callback of obsoleteSamples) callback();
  assert.equal(f.samples, 0);
  f.clock.advance(HANDOFF_COMMIT_TIMEOUT_MS);
  assert.equal(f.samples, 2); assert.deepEqual(f.failures, [['h1', 'commit-timeout']]);
});

test('a preparation still not ready after the stall window says why, once', async () => {
  const f = fixture(); await f.prepare('h1', { desiredState: 2 });
  f.player.state = 3; f.player.buffer = 0;
  f.clock.advance(HANDOFF_STALL_REPORT_MS - 1);
  assert.deepEqual(f.stalled, []);
  f.clock.advance(1);
  assert.deepEqual(f.stalled, [['h1', { blocker: 'state-3', playerState: 3, buffered: 0, muted: true }]]);
  f.clock.advance(60_000);
  assert.equal(f.stalled.length, 1);
});

test('a player that never becomes ready is reported even though cue never ran', async () => {
  const f = fixture(); f.setPlayer(null); await f.prepare();
  assert.equal(f.clock.timers.size, 1, 'no readiness polling without a player, only the stall report');
  f.clock.advance(HANDOFF_STALL_REPORT_MS);
  assert.deepEqual(f.stalled, [['h1', { blocker: 'player-not-ready', playerState: null, buffered: null, muted: null }]]);
});

test('readiness names the first unmet condition', async () => {
  const f = fixture(); await f.prepare('h1', { desiredState: 2 });
  f.player.videoId = 'other-video';
  assert.equal(f.owner.readiness().blocker, 'video-not-loaded');
  f.player.videoId = VIDEO; f.player.muted = false;
  assert.equal(f.owner.readiness().blocker, 'not-muted');
  f.player.muted = true; f.player.state = -1;
  assert.equal(f.owner.readiness().blocker, 'state--1');
  f.player.state = 2; f.player.buffer = 0;
  assert.equal(f.owner.readiness().blocker, 'not-buffered');
  f.player.buffer = 0.4;
  assert.equal(f.owner.readiness().blocker, null);
  f.failReads();
  assert.equal(f.owner.readiness().blocker, 'player-unreadable');
});

test('a ready, replaced or cancelled preparation never reports a stall', async () => {
  const ready = fixture(); await ready.prepare('h1', { desiredState: 2 });
  ready.player.state = 2; assert.equal(ready.owner.announceReady(), true);
  const replaced = fixture(); await replaced.prepare('h1'); await replaced.prepare('h2'); replaced.player.state = 3;
  const cancelled = fixture(); await cancelled.prepare(); cancelled.owner.cancel();
  for (const f of [ready, replaced, cancelled]) f.clock.advance(HANDOFF_STALL_REPORT_MS);
  assert.deepEqual(ready.stalled, []);
  assert.deepEqual(replaced.stalled.map(([id]) => id), ['h2']);
  assert.deepEqual(cancelled.stalled, []);
});
