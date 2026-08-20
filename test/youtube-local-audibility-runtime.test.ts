import assert from 'node:assert/strict';
import test from 'node:test';

type Listener = (event: any) => void;

class FakeWindow {
  YT: { Player: any };
  onYouTubeIframeAPIReady?: () => void;
  private listeners = new Map<string, Listener[]>();

  constructor(Player: any) {
    this.YT = { Player };
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, detail: Record<string, unknown> = {}) {
    const event = { type, detail };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakePlayer {
  muted = false;
  muteCalls = 0;
  unMuteCalls = 0;

  constructor(_target: unknown, _options: unknown) {}

  mute() {
    this.muted = true;
    this.muteCalls += 1;
  }

  unMute() {
    this.muted = false;
    this.unMuteCalls += 1;
  }

  isMuted() {
    return this.muted;
  }
}

class LateApiPlayer {
  muted = false;
  muteCalls = 0;
  unMuteCalls = 0;
  options: any;

  constructor(_target: unknown, options: unknown) {
    this.options = options;
  }

  mute() {
    this.muted = true;
    this.muteCalls += 1;
  }

  isMuted() {
    return this.muted;
  }
}

test('Take review keeps a holder player locally muted and restores prior audibility', async () => {
  const fakeWindow = new FakeWindow(FakePlayer);
  const globals = globalThis as any;
  const previousWindow = globals.window;
  globals.window = fakeWindow;

  try {
    const moduleUrl = new URL('../public/youtube-local-audibility.js', import.meta.url);
    moduleUrl.searchParams.set('runtime-test', `${Date.now()}-${Math.random()}`);
    await import(moduleUrl.href);

    const WrappedPlayer = fakeWindow.YT.Player;
    assert.notEqual(WrappedPlayer, FakePlayer);
    const player = new WrappedPlayer('youtube-player', {}) as FakePlayer;

    fakeWindow.dispatch('relay:playback-view', { role: 'holder' });
    fakeWindow.dispatch('relay-take-review-playback', { active: true });
    assert.equal(player.muted, true);

    const unmuteCallsDuringReview = player.unMuteCalls;
    player.unMute();
    assert.equal(player.muted, true, 'handoff/local unmute must be suppressed while Take review is active');
    assert.equal(player.unMuteCalls, unmuteCallsDuringReview);

    fakeWindow.dispatch('relay-take-review-playback', { active: false });
    assert.equal(player.muted, false);
    assert.equal(player.unMuteCalls, unmuteCallsDuringReview + 1);
  } finally {
    fakeWindow.dispatch('relay-take-review-playback', { active: false });
    fakeWindow.dispatch('beforeunload');
    globals.window = previousWindow;
  }
});

test('Take review guard can attach when YT exposes unMute only at onReady', async () => {
  const fakeWindow = new FakeWindow(LateApiPlayer);
  const globals = globalThis as any;
  const previousWindow = globals.window;
  globals.window = fakeWindow;

  try {
    const moduleUrl = new URL('../public/youtube-local-audibility.js', import.meta.url);
    moduleUrl.searchParams.set('runtime-test', `late-${Date.now()}-${Math.random()}`);
    await import(moduleUrl.href);

    const WrappedPlayer = fakeWindow.YT.Player;
    const player = new WrappedPlayer('youtube-player', {}) as LateApiPlayer & { unMute?: () => void };
    assert.equal(typeof player.unMute, 'undefined');

    player.unMute = () => {
      player.muted = false;
      player.unMuteCalls += 1;
    };
    player.options.events.onReady({ target: player });

    fakeWindow.dispatch('relay:playback-view', { role: 'holder' });
    fakeWindow.dispatch('relay-take-review-playback', { active: true });
    assert.equal(player.muted, true);

    const calls = player.unMuteCalls;
    player.unMute?.();
    assert.equal(player.muted, true);
    assert.equal(player.unMuteCalls, calls, 'late unMute must be guarded after onReady attachment');
  } finally {
    fakeWindow.dispatch('relay-take-review-playback', { active: false });
    fakeWindow.dispatch('beforeunload');
    globals.window = previousWindow;
  }
});
