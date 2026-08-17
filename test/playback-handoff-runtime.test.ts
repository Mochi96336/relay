import assert from 'node:assert/strict';
import test from 'node:test';

class RuntimeEvent {
  constructor(
    public readonly type: string,
    public readonly detail: unknown = undefined,
  ) {}
}

class EventBus {
  private readonly listeners = new Map<string, Array<(event: RuntimeEvent) => void>>();

  addEventListener(type: string, listener: (event: RuntimeEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: RuntimeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

class FakeElement extends EventBus {
  textContent = '';
  value = '';
}

class FakePlayer {
  state = -1;
  currentTime = 0;
  duration = 200;
  playbackRate = 1;
  bufferedFraction = 0.8;
  muted = false;
  unmuteCalls = 0;
  videoId: string;

  constructor(
    public readonly options: Record<string, any>,
    videoId: string,
  ) {
    this.videoId = videoId;
  }

  getIframe() { return {} as Record<string, unknown>; }
  getPlayerState() { return this.state; }
  getCurrentTime() { return this.currentTime; }
  getDuration() { return this.duration; }
  getPlaybackRate() { return this.playbackRate; }
  getVideoLoadedFraction() { return this.bufferedFraction; }
  getVideoData() { return { video_id: this.videoId }; }
  isMuted() { return this.muted; }
  mute() { this.muted = true; }
  unMute() { this.muted = false; this.unmuteCalls += 1; }
  setPlaybackRate(value: number) { this.playbackRate = value; }
  seekTo(value: number) { this.currentTime = value; this.state = 3; }
  playVideo() { this.state = 1; }
  pauseVideo() { this.state = 2; }
  cueVideoById({ videoId, startSeconds = 0 }: { videoId: string; startSeconds?: number }) {
    this.videoId = videoId;
    this.currentTime = startSeconds;
    this.state = 5;
  }
  loadVideoById({ videoId, startSeconds = 0 }: { videoId: string; startSeconds?: number }) {
    this.videoId = videoId;
    this.currentTime = startSeconds;
    this.state = 3;
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('runtime preserves prewarm mute provenance and requires PLAYING before handoff ready', async () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;
  const originalLocation = (globalThis as any).location;
  const originalCustomEvent = (globalThis as any).CustomEvent;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  const bus = new EventBus();
  const documentBus = new EventBus();
  const elements = new Map<string, FakeElement>([
    ['#youtube-url', new FakeElement()],
    ['#load-youtube', new FakeElement()],
    ['#youtube-state', new FakeElement()],
    ['#youtube-timeline', new FakeElement()],
    ['#youtube-note', new FakeElement()],
  ]);
  let player: FakePlayer | null = null;
  let timerSequence = 0;

  try {
    (globalThis as any).CustomEvent = class extends RuntimeEvent {
      constructor(type: string, init: { detail?: unknown } = {}) {
        super(type, init.detail);
      }
    };
    (globalThis as any).window = {
      relayI18n: { t: (key: string) => key },
      addEventListener: bus.addEventListener.bind(bus),
      dispatchEvent: bus.dispatchEvent.bind(bus),
      YT: {
        Player: function Player(_elementId: string, options: Record<string, any>) {
          player = new FakePlayer(options, String(options.videoId ?? ''));
          return player;
        },
      },
    };
    (globalThis as any).document = {
      querySelector: (selector: string) => elements.get(selector) ?? null,
      addEventListener: documentBus.addEventListener.bind(documentBus),
      head: { append() {} },
      createElement: () => new FakeElement(),
    };
    (globalThis as any).location = { origin: 'https://relay.test' };

    globalThis.setTimeout = (((handler: (...args: any[]) => void, _delay?: number) => {
      timerSequence += 1;
      // Delayed readiness/watchdog work is deliberately not executed here. The
      // state-change callbacks below exercise the same runtime transition
      // synchronously without making this test sleep for production timers.
      void handler;
      return timerSequence;
    }) as unknown) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    globalThis.setInterval = (((handler: (...args: any[]) => void, _delay?: number) => {
      timerSequence += 1;
      void handler;
      return timerSequence;
    }) as unknown) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    await import('../public/youtube.js');

    const VIDEO = 'dQw4w9WgXcQ';
    bus.dispatchEvent(new RuntimeEvent('relay:playback-view', {
      role: 'observer',
      room: {
        videoId: VIDEO,
        state: 1,
        serverTime: 10,
        playbackRate: 1,
      },
      timeline: {
        videoId: VIDEO,
        state: 1,
        handoffState: 'idle',
        playbackLeaderParticipantId: 'participant-a',
        playbackTransportId: 'playback-a',
        playbackGeneration: 1,
      },
      transportId: 'playback-b',
      playbackGeneration: 1,
    }));

    bus.dispatchEvent(new RuntimeEvent('relay:playback-prewarm-intent'));
    await flushMicrotasks();
    assert.ok(player, 'prewarm did not create the YouTube player');
    player.options.events.onReady({ target: player });
    assert.equal(player.muted, true, 'first prewarm must mute the local media request');

    // A duplicate Mic tap refreshes the same speculative attempt. If the second
    // attempt overwrites `wasMuted` after Relay has already muted the player,
    // cancel would incorrectly preserve that Relay-owned mute forever.
    bus.dispatchEvent(new RuntimeEvent('relay:playback-prewarm-intent'));
    await flushMicrotasks();
    assert.equal(player.muted, true);
    bus.dispatchEvent(new RuntimeEvent('relay:playback-prewarm-cancel'));
    assert.equal(player.muted, false, 'cancel must restore the original audible state');
    assert.equal(player.unmuteCalls, 1);

    let readyCount = 0;
    bus.addEventListener('relay:song-handoff-ready', () => { readyCount += 1; });
    bus.dispatchEvent(new RuntimeEvent('relay:song-handoff-prepare', {
      handoffId: 'handoff-runtime',
      videoId: VIDEO,
      state: 1,
      serverTime: 12,
      playbackRate: 1,
    }));
    await flushMicrotasks();

    player.state = 3;
    player.bufferedFraction = 0.9;
    player.options.events.onStateChange({ data: 3 });
    assert.equal(readyCount, 0,
      'BUFFERING plus a non-zero loaded fraction must not cross the ready boundary');

    player.state = 1;
    player.currentTime = 12.1;
    player.options.events.onStateChange({ data: 1 });
    assert.equal(readyCount, 1, 'PLAYING on the exact prepared video should announce readiness once');
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).location = originalLocation;
    (globalThis as any).CustomEvent = originalCustomEvent;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
