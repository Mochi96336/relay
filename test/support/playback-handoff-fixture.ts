import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FakeClock } from './fake-clock.js';

let sequence = 0;
export const SONG = 'dQw4w9WgXcQ';

/** Runs the whole production browser module through its public window events. */
export async function playbackHandoffFixture(t: TestContext, { readyDelayMs = 0 } = {}) {
  const clock = new FakeClock();
  class Element extends EventTarget {
    textContent = ''; value = ''; dataset: Record<string, string> = {};
    remove() { if (apiScript === this) apiScript = null; }
  }
  let apiScript: Element | null = null;
  const elements = new Map<string, Element>();
  const document = Object.assign(new EventTarget(), {
    head: { append(element: Element) { apiScript = element; } },
    createElement() { return new Element(); },
    querySelector(selector: string) {
      if (selector === 'script[data-relay-youtube-api]') return apiScript;
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector)!;
    },
  });
  const events: { type: string; detail: Record<string, unknown> }[] = [];
  const window = Object.assign(new EventTarget(), { YT: {} as { Player?: typeof Player }, onYouTubeIframeAPIReady: undefined as (() => void) | undefined });
  for (const type of ['relay:song-handoff-ready', 'relay:song-handoff-failed', 'relay:youtube-telemetry', 'relay:room-song-command-intent', 'relay:room-song-command-failed', 'relay:song-handoff-stalled']) {
    window.addEventListener(type, event => events.push({ type, detail: (event as CustomEvent<Record<string, unknown>>).detail }));
  }
  const players: Player[] = [];
  const commands: unknown[][] = [];
  class Player {
    videoId: string;
    readonly initialVideoId: string;
    position = 0;
    state = 5;
    buffer = 0.5;
    rate = 1;
    muted = false;
    pauseOnUnmute = false;
    failMute = false;
    callbacks: Record<string, (event: { target?: Player; data?: number }) => void>;
    constructor(_element: string, options: { videoId: string; events: Player['callbacks'] }) {
      this.videoId = options.videoId; this.initialVideoId = options.videoId;
      this.callbacks = options.events;
      players.push(this);
      clock.setTimeout(() => this.callbacks.onReady({ target: this }), readyDelayMs);
    }
    getIframe() { return { referrerPolicy: '' }; }
    getVideoData() { return { video_id: this.videoId }; }
    getPlayerState() { return this.state; }
    getCurrentTime() { return this.position; }
    getDuration() { return 200; }
    getVideoLoadedFraction() { return this.buffer; }
    getPlaybackRate() { return this.rate; }
    isMuted() { return this.muted; }
    mute() { if (this.failMute) throw Error('test: mute failed'); this.muted = true; commands.push(['mute']); }
    unMute() { this.muted = false; if (this.pauseOnUnmute) this.state = 2; commands.push(['unmute']); }
    loadVideoById(input: { videoId: string; startSeconds: number }) {
      this.videoId = input.videoId; this.position = input.startSeconds; this.state = 1;
      commands.push(['load', input.videoId, input.startSeconds]);
    }
    cueVideoById(input: { videoId: string; startSeconds: number }) {
      this.videoId = input.videoId; this.position = input.startSeconds; this.state = 5;
      commands.push(['cue', input.videoId, input.startSeconds]);
    }
    seekTo(position: number) { this.position = position; commands.push(['seek', position]); }
    setPlaybackRate(rate: number) { this.rate = rate; commands.push(['rate', rate]); }
    playVideo() { this.state = 1; commands.push(['play']); }
    pauseVideo() { this.state = 2; commands.push(['pause']); }
    emit(state: number) { this.state = state; this.callbacks.onStateChange({ data: state }); }
  }
  window.YT.Player = Player;
  const globals = { window, document, location: { origin: 'http://relay.test' },
    performance: { now: () => clock.now, timeOrigin: 100000 },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const root = process.env.RELAY_HANDOFF_RUNTIME_ROOT;
  const url = root ? pathToFileURL(`${root}/public/youtube.js`) : new URL('../../public/youtube.js', import.meta.url);
  await import(`${url.href}?handoff-case=${++sequence}`);
  const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); clock.advance(0); } };
  const send = (type: string, detail: object = {}) => window.dispatchEvent(new CustomEvent(`relay:${type}`, { detail }));
  const prepare = async (id = 'h1', overrides: Record<string, unknown> = {}) => {
    send('song-handoff-prepare', { handoffId: id, videoId: SONG, serverTime: 40, state: 1, playbackRate: 1, ...overrides });
    await flush();
  };
  const commit = (id = 'h1', overrides: Record<string, unknown> = {}) => {
    send('song-handoff-commit', { handoffId: id, serverTime: 41, state: 1, ...overrides });
  };
  return { clock, events, commands, send, prepare, commit, flush, window, elements,
    deferApi() { window.YT.Player = undefined; },
    resolveApi() { window.YT.Player = Player; window.onYouTubeIframeAPIReady?.(); },
    rejectApi() { apiScript?.dispatchEvent(new Event('error')); },
    get player() { return players[0]; }, players };
}
