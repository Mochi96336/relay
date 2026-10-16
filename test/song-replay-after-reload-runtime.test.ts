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

const VIDEO = 'dQw4w9WgXcQ';
const DURATION = 19;
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const CUED = 5;

const clock = { nowMs: 1_000 };

/** A YouTube player whose media time advances with the test clock while PLAYING. */
class FakePlayer {
  state = -1;
  baseSeconds = 0;
  startedAtMs = 0;
  playbackRate = 1;
  videoId: string;

  constructor(
    public readonly options: Record<string, any>,
    videoId: string,
  ) {
    this.videoId = videoId;
  }

  set(state: number, seconds: number) {
    this.state = state;
    this.baseSeconds = seconds;
    this.startedAtMs = clock.nowMs;
  }

  getCurrentTime() {
    if (this.state !== PLAYING) return this.baseSeconds;
    return Math.min(DURATION, this.baseSeconds + ((clock.nowMs - this.startedAtMs) / 1000) * this.playbackRate);
  }

  getIframe() { return {} as Record<string, unknown>; }
  getPlayerState() { return this.state; }
  getDuration() { return DURATION; }
  getPlaybackRate() { return this.playbackRate; }
  getVideoLoadedFraction() { return 1; }
  getVideoData() { return { video_id: this.videoId }; }
  isMuted() { return false; }
  mute() {}
  unMute() {}
  setPlaybackRate(value: number) { this.playbackRate = value; }
  seekTo(value: number) { this.set(this.state === PLAYING ? PLAYING : BUFFERING, value); }
  playVideo() { this.set(PLAYING, this.baseSeconds); }
  pauseVideo() { this.set(PAUSED, this.getCurrentTime()); }
  cueVideoById({ videoId, startSeconds = 0 }: { videoId: string; startSeconds?: number }) {
    this.videoId = videoId;
    this.set(CUED, startSeconds);
  }
  loadVideoById({ videoId, startSeconds = 0 }: { videoId: string; startSeconds?: number }) {
    this.videoId = videoId;
    this.set(BUFFERING, startSeconds);
  }
}

/**
 * A reloaded holder page restores a room whose song had finished, the server
 * promotes it, and the singer then presses Play in the YouTube player. Returns
 * every room command the page asked for after that press.
 */
async function replayFinishedSongAfterReload(pressPlay: (player: FakePlayer, advance: (ms: number) => void) => void) {
  const saved = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
    location: (globalThis as any).location,
    CustomEvent: (globalThis as any).CustomEvent,
    performance: Object.getOwnPropertyDescriptor(globalThis, 'performance'),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  const bus = new EventBus();
  const elements = new Map<string, FakeElement>(
    ['#youtube-url', '#load-youtube', '#youtube-state', '#youtube-timeline', '#youtube-note']
      .map((selector) => [selector, new FakeElement()]),
  );
  const runtime = { player: null as FakePlayer | null, sampler: null as (() => void) | null };

  try {
    (globalThis as any).CustomEvent = class extends RuntimeEvent {
      constructor(type: string, init: { detail?: unknown } = {}) {
        super(type, init.detail);
      }
    };
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { now: () => clock.nowMs, timeOrigin: 0 },
    });
    (globalThis as any).window = {
      relayI18n: { t: (key: string) => key },
      addEventListener: bus.addEventListener.bind(bus),
      dispatchEvent: bus.dispatchEvent.bind(bus),
      YT: {
        Player: function Player(_elementId: string, options: Record<string, any>) {
          runtime.player = new FakePlayer(options, String(options.videoId ?? ''));
          return runtime.player;
        },
      },
    };
    (globalThis as any).document = {
      querySelector: (selector: string) => elements.get(selector) ?? null,
      addEventListener() {},
      head: { append() {} },
      createElement: () => new FakeElement(),
    };
    (globalThis as any).location = { origin: 'https://relay.test' };
    // Delayed work stays unexecuted; the test drives the 250 ms sampler itself.
    globalThis.setTimeout = ((() => 0) as unknown) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    globalThis.setInterval = (((handler: () => void) => {
      runtime.sampler = handler;
      return 1;
    }) as unknown) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    const runtimeImport = Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<unknown>;
    const moduleUrl = new URL('../public/youtube.js', import.meta.url);
    moduleUrl.searchParams.set('runtime-test', `${Date.now()}-${Math.random()}`);
    await runtimeImport(moduleUrl.href);

    const advance = (ms: number) => {
      clock.nowMs += ms;
      runtime.sampler?.();
    };
    const view = (leaderGeneration: number) => bus.dispatchEvent(new RuntimeEvent('relay:playback-view', {
      role: 'holder',
      room: { videoId: VIDEO, state: ENDED, serverTime: DURATION, playbackRate: 1 },
      timeline: {
        videoId: VIDEO,
        state: ENDED,
        serverTime: DURATION,
        playbackRate: 1,
        handoffState: 'idle',
        playbackLeaderParticipantId: 'participant-a',
        playbackTransportId: 'tab-a',
        playbackGeneration: leaderGeneration,
      },
      transportId: 'tab-a',
      playbackGeneration: 2,
    }));

    // The reloaded page (generation 2) restores the finished room at its end.
    view(1);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    const player = runtime.player;
    assert.ok(player, 'restore did not create the YouTube player');
    player.set(CUED, 0);
    player.options.events.onReady({ target: player });
    advance(250);
    assert.equal(player.state, PAUSED);
    assert.equal(player.getCurrentTime(), DURATION);

    // Its paused-at-the-end proof promoted it to the room's leader.
    view(2);

    const commands: Array<Record<string, unknown>> = [];
    bus.addEventListener('relay:room-song-command-intent', (event) => {
      commands.push(event.detail as Record<string, unknown>);
    });
    pressPlay(player, advance);
    for (let i = 0; i < 4; i += 1) advance(250);
    return commands;
  } finally {
    (globalThis as any).window = saved.window;
    (globalThis as any).document = saved.document;
    (globalThis as any).location = saved.location;
    (globalThis as any).CustomEvent = saved.CustomEvent;
    if (saved.performance) Object.defineProperty(globalThis, 'performance', saved.performance);
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    globalThis.setInterval = saved.setInterval;
    globalThis.clearInterval = saved.clearInterval;
  }
}

test('Play on a finished song after reload asks the room to play, not only to jump back', async () => {
  // YouTube can report the restart as one sample: back at the start and
  // already PLAYING, with no BUFFERING in between.
  const commands = await replayFinishedSongAfterReload((player) => {
    player.set(PLAYING, 0);
    player.options.events.onStateChange({ data: PLAYING });
  });

  assert.deepEqual(commands.map((command) => command.action), ['seek', 'play']);
  assert.ok(Number(commands[0].positionSeconds) < 0.75);
});

test('a restart reported through BUFFERING still ends with Play', async () => {
  const commands = await replayFinishedSongAfterReload((player, advance) => {
    player.set(BUFFERING, 0);
    player.options.events.onStateChange({ data: BUFFERING });
    clock.nowMs += 250;
    player.set(PLAYING, 0);
    player.options.events.onStateChange({ data: PLAYING });
    void advance;
  });

  assert.deepEqual(commands.map((command) => command.action), ['seek', 'play']);
});
