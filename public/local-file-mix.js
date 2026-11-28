import { storeNumber, storedNumber } from './device-preferences.js';

// Local file mode: the singer's phone plays a song from its own storage and
// mixes it with the Mic before capture, so the Mic carries the whole program.
// Relay mixes that capture at unity and serves it to Listen and Takes as is.
//
// The song and the Mic run on the capture AudioContext, so they share one
// clock and cannot drift. What separates them is constant: the singer sings
// to the song as it leaves the speaker (output latency) and the voice reaches
// the capture later still (input latency). The song is delayed by that round
// trip on its way into the mix, and the singer's own ears hear it undelayed.
//
// One person, one device: nothing here is shared with the room except the
// mixed capture itself.

export const LOCAL_FILE_OFFSET_KEY = 'relay.localFileOffsetMs.v1';
export const LOCAL_FILE_MUSIC_LEVEL_KEY = 'relay.localFileMusicLevel.v1';
export const MAX_OFFSET_MS = 500;
// The offset slider's step; its lower end stays on this grid so 0 is reachable.
export const OFFSET_STEP_MS = 5;
const MAX_DELAY_SECONDS = 2;
// The server's song level at the voice + song sum (backingGain), so a local
// song sits against the voice as a room song does.
const DEFAULT_MUSIC_LEVEL = 0.65;
// A reported latency that moves by less than this is noise, not a new route;
// following it would bend the song's pitch for nothing.
const RETUNE_THRESHOLD_SECONDS = 0.008;
const RETUNE_INTERVAL_MS = 2000;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Seconds from a song sample leaving the graph to the voice sung against it
 * entering the capture: graph buffer + output route + input route. Browsers
 * that do not report a part count it as zero; the offset covers the rest.
 */
export function roundTripLatencySeconds({ baseLatency, outputLatency, inputLatency }) {
  return finiteNonNegative(baseLatency) + finiteNonNegative(outputLatency) + finiteNonNegative(inputLatency);
}

/** The song's delay into the mix: measured round trip plus the singer's offset, clamped. */
export function songDelaySeconds(roundTripSeconds, offsetMs) {
  const total = roundTripSeconds + (Number.isFinite(offsetMs) ? offsetMs : 0) / 1000;
  return Math.max(0, Math.min(MAX_DELAY_SECONDS, total));
}

function trackInputLatency(stream) {
  try {
    return stream?.getAudioTracks?.()[0]?.getSettings?.().latency ?? 0;
  } catch {
    return 0;
  }
}

function dbToGain(db) {
  return 10 ** (db / 20);
}

function limiter(context, thresholdDb, releaseSeconds) {
  const node = context.createDynamicsCompressor();
  node.threshold.value = thresholdDb;
  node.knee.value = 0;
  node.ratio.value = 20;
  node.attack.value = 0.001;
  node.release.value = releaseSeconds;
  node.channelCount = 1;
  node.channelCountMode = 'explicit';
  return node;
}

/**
 * How this page's song area shows local file mode.
 * - 'owner': this phone's file is the room's song (it holds the Mic, or
 *   nobody does yet) and replaces the YouTube surface;
 * - 'standby': a file is open here but someone else holds the Mic, whose
 *   room song stays visible;
 * - 'observer': a local file is the room's song and this page does not hold
 *   it: another phone, or another tab of this participant (`capturing` is
 *   false), shows its title read-only;
 * - 'none'.
 * A page that captures the Mic with no file open is not the room's local
 * file even when the room still announces one (it is closing).
 */
export function localFileSurface({ fileOpen, myId, micOwnerId, roomLocalFile, capturing = false }) {
  const othersMic = typeof micOwnerId === 'string' && micOwnerId !== myId;
  if (fileOpen) return othersMic ? 'standby' : 'owner';
  if (!roomLocalFile || typeof micOwnerId !== 'string') return 'none';
  return othersMic || !capturing ? 'observer' : 'none';
}

/**
 * The room's song (relay:playback-view `room`) is moving: YouTube PLAYING (1)
 * or BUFFERING (3). The room reports YouTube's numeric player state, never a
 * word, so a cued (5) or paused (2) song leaves the local file free.
 */
export function roomSongHoldsLocalFile(room) {
  const state = Number(room?.state);
  return state === 1 || state === 3;
}

/** This page held the Mic and someone else holds it now: its local file is over. */
export function lostMicToAnother({ previousOwnerId, nextOwnerId, myId }) {
  return typeof myId === 'string' && previousOwnerId === myId
    && typeof nextOwnerId === 'string' && nextOwnerId !== myId;
}

export class LocalFileMix extends EventTarget {
  #file = null; // { url, name }
  #graph = null; // nodes bound to one AudioContext
  #attachment = null; // the capture currently fed: { context, stream, source, capture }
  #links = null; // that capture's connections into #graph
  #position = 0;
  #wantPlaying = false;
  #vocalGainDb = 24;
  #offsetMs;
  #musicLevel;
  #roundTripSeconds = 0;
  #retuneTimer = null;
  // Each play() request, pause and teardown takes a new number; a play still
  // waiting on the device or the element acts only while its number is current.
  #playRequest = 0;
  #createElement;

  constructor({ createElement = () => new Audio() } = {}) {
    super();
    this.#createElement = createElement;
    this.#offsetMs = storedNumber(LOCAL_FILE_OFFSET_KEY, -MAX_OFFSET_MS, MAX_OFFSET_MS) ?? 0;
    this.#musicLevel = storedNumber(LOCAL_FILE_MUSIC_LEVEL_KEY, 0, 1) ?? DEFAULT_MUSIC_LEVEL;
  }

  /** A file is open: the Mic capture carries the mix. */
  get active() { return this.#file !== null; }
  get title() { return this.#file?.name ?? null; }
  /** A Mic capture is running the song, so it can play. */
  get attached() { return this.#graph !== null && this.#graph.context.state !== 'closed'; }
  get playing() { return Boolean(this.#graph && !this.#graph.element.paused && !this.#graph.element.ended); }
  get currentTime() { return this.#graph ? this.#graph.element.currentTime : this.#position; }
  get duration() {
    const value = this.#graph?.element.duration;
    return Number.isFinite(value) ? value : null;
  }
  get roundTripMs() { return Math.round(this.#roundTripSeconds * 1000); }
  /** The singer's requested offset, as stored. */
  get offsetMs() { return this.#offsetMs; }
  /**
   * The furthest "voice later" this capture can apply: the song cannot be
   * delayed by less than nothing, so a negative offset takes back at most
   * the measured round trip (on the slider's grid).
   */
  get minOffsetMs() {
    if (!this.attached) return -MAX_OFFSET_MS;
    const roundTripSteps = Math.floor((this.#roundTripSeconds * 1000) / OFFSET_STEP_MS);
    return Math.max(-MAX_OFFSET_MS, 0 - roundTripSteps * OFFSET_STEP_MS);
  }
  /** The offset the song delay carries now: the request within what this capture can apply. */
  get appliedOffsetMs() { return Math.max(this.#offsetMs, this.minOffsetMs); }
  get musicLevel() { return this.#musicLevel; }

  #changed(kind) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  open(file) {
    if (!file) return;
    const wasActive = this.active;
    this.#teardown();
    if (this.#file) URL.revokeObjectURL(this.#file.url);
    this.#file = { url: URL.createObjectURL(file), name: file.name.replace(/\.[^.]+$/, '') || file.name };
    this.#position = 0;
    this.#wantPlaying = false;
    // A second file keeps the same capture (and its premixed registration):
    // only the song nodes are replaced. A mode change needs a new capture.
    if (wasActive && this.#attachment) this.#connect(this.#attachment);
    this.#changed(wasActive ? 'file' : 'mode');
  }

  close() {
    if (!this.#file) return;
    this.#teardown();
    this.#attachment = null;
    URL.revokeObjectURL(this.#file.url);
    this.#file = null;
    this.#position = 0;
    this.#wantPlaying = false;
    this.#changed('mode');
  }

  /**
   * mic-capture-graph's input hook. Builds (or reuses) the song nodes on this
   * context and routes Mic + delayed song into the capture. Returns null when
   * no file is open, so the Mic is captured alone.
   */
  connectInput = ({ context, stream, source, capture }) => {
    if (!this.#file) return null;
    const attachment = { context, stream, source, capture };
    this.#connect(attachment);
    return {
      disconnect: () => {
        if (this.#attachment !== attachment) return;
        this.#unlink();
        this.#attachment = null;
      },
    };
  };

  #connect(attachment) {
    const { context, stream, source, capture } = attachment;
    this.#unlink();
    if (this.#graph && (this.#graph.context !== context || this.#graph.url !== this.#file.url)) this.#teardown();
    this.#graph ??= this.#build(context);
    const graph = this.#graph;
    graph.stream = stream;
    source.connect(graph.vocalGain);
    graph.output.connect(capture);
    this.#attachment = attachment;
    this.#links = { graph, source, capture };
    this.#retune(true);
    this.#changed('attached');
  }

  #unlink() {
    const links = this.#links;
    this.#links = null;
    if (!links) return;
    try { links.source.disconnect(links.graph.vocalGain); } catch {}
    try { links.graph.output.disconnect(links.capture); } catch {}
  }

  #build(context) {
    const element = this.#createElement();
    element.preload = 'auto';
    element.setAttribute?.('playsinline', '');
    element.src = this.#file.url;
    const song = context.createMediaElementSource(element);
    // What the singer hears: the song itself, undelayed.
    song.connect(context.destination);

    const musicGain = context.createGain();
    musicGain.gain.value = this.#musicLevel;
    const delay = context.createDelay(MAX_DELAY_SECONDS);
    const vocalGain = context.createGain();
    vocalGain.gain.value = dbToGain(this.#vocalGainDb);
    // The voice's own peak limiter, as the server's would have been.
    const vocalLimiter = limiter(context, -3, 0.15);
    // Mono sum: the capture reads one channel, so a stereo song is folded
    // here instead of losing its right side.
    const sum = context.createGain();
    sum.channelCount = 1;
    sum.channelCountMode = 'explicit';
    sum.channelInterpretation = 'speakers';
    const output = limiter(context, -1.5, 0.1);
    // The voice's limiter holds it back by its lookahead (6 ms in Chromium)
    // before the sum. The song takes a compressor that never compresses
    // (ratio 1) for the same lookahead, so zero offset means aligned in any
    // browser whatever its lookahead is.
    const songLatencyMatch = context.createDynamicsCompressor();
    songLatencyMatch.threshold.value = 0;
    songLatencyMatch.knee.value = 0;
    songLatencyMatch.ratio.value = 1;
    songLatencyMatch.attack.value = 0.001;
    songLatencyMatch.release.value = 0.15;

    song.connect(musicGain).connect(songLatencyMatch).connect(delay).connect(sum);
    vocalGain.connect(vocalLimiter).connect(sum);
    sum.connect(output);

    const graph = { context, url: this.#file.url, element, song, musicGain, songLatencyMatch, delay,
      vocalGain, vocalLimiter, sum, output, stream: null, onState: null };
    // Read the intent when the file has loaded, not when the graph was built:
    // a pause or seek made while it loaded is the newer request.
    element.addEventListener('loadedmetadata', () => {
      if (this.#graph !== graph) return;
      const resume = this.#position;
      if (resume > 0) element.currentTime = Math.min(resume, element.duration || resume);
      if (this.#wantPlaying) void this.play();
      this.#changed('metadata');
    }, { once: true });
    for (const type of ['play', 'pause', 'ended', 'seeked']) {
      element.addEventListener(type, () => {
        if (this.#graph !== graph) return;
        if (type === 'ended') this.#wantPlaying = false;
        this.#changed(type);
      });
    }
    element.addEventListener('timeupdate', () => { if (this.#graph === graph) this.#changed('time'); });
    graph.onState = () => {
      if (context.state === 'closed' && this.#graph === graph) {
        // The Mic stopped (released, revoked, or lost). Taking it again
        // later must not start the song by itself.
        this.#teardown({ resume: false });
        this.#changed('detached');
      }
    };
    context.addEventListener?.('statechange', graph.onState);
    return graph;
  }

  /**
   * `resume`: a replacement capture context (clock-loss recovery) carries
   * on playing where this one was; the end of the Mic session does not.
   */
  #teardown({ resume = true } = {}) {
    const graph = this.#graph;
    if (!graph) return;
    if (this.#links?.graph === graph) this.#unlink();
    this.#graph = null;
    this.#playRequest += 1;
    clearInterval(this.#retuneTimer);
    this.#retuneTimer = null;
    this.#position = graph.element.currentTime || this.#position;
    if (!resume) this.#wantPlaying = false;
    else if (!graph.element.paused) this.#wantPlaying = true;
    try { graph.context.removeEventListener?.('statechange', graph.onState); } catch {}
    try { graph.element.pause(); } catch {}
    // A media element can feed only the context it was first bound to; a
    // later context gets a fresh element on the same file.
    try { graph.element.removeAttribute('src'); graph.element.load(); } catch {}
    for (const node of [graph.song, graph.musicGain, graph.songLatencyMatch, graph.delay, graph.vocalGain,
      graph.vocalLimiter, graph.sum, graph.output]) {
      try { node.disconnect(); } catch {}
    }
  }

  #retune(force = false) {
    const graph = this.#graph;
    if (!graph) return;
    const roundTrip = roundTripLatencySeconds({
      baseLatency: graph.context.baseLatency,
      outputLatency: graph.context.outputLatency,
      inputLatency: trackInputLatency(graph.stream),
    });
    if (!force && Math.abs(roundTrip - this.#roundTripSeconds) < RETUNE_THRESHOLD_SECONDS) return;
    this.#roundTripSeconds = roundTrip;
    this.#applyDelay();
    this.#changed('latency');
  }

  #applyDelay() {
    const graph = this.#graph;
    if (!graph) return;
    const target = songDelaySeconds(this.#roundTripSeconds, this.appliedOffsetMs);
    const param = graph.delay.delayTime;
    if (graph.element.paused) param.value = target;
    else param.setTargetAtTime(target, graph.context.currentTime, 0.05);
  }

  async play() {
    const graph = this.#graph;
    this.#wantPlaying = true;
    if (!graph) {
      this.#changed('needs-mic');
      return false;
    }
    const request = ++this.#playRequest;
    // A pause, another play, a new file or the end of the capture while this
    // request awaited the device or the element is the newer intent.
    const current = () => request === this.#playRequest && this.#graph === graph && this.#wantPlaying;
    try {
      if (graph.context.state !== 'running') await graph.context.resume();
      if (!current()) return false;
      this.#retune(true);
      await graph.element.play();
    } catch (error) {
      if (!current()) return false;
      console.warn('Local file playback failed', error);
      this.#wantPlaying = false;
      this.#changed('play-failed');
      return false;
    }
    if (!current()) {
      // The element started after the request was withdrawn.
      if (this.#graph === graph && !this.#wantPlaying) {
        try { graph.element.pause(); } catch {}
      }
      return false;
    }
    clearInterval(this.#retuneTimer);
    // Chromium refines outputLatency after output starts, and a route change
    // (headphones plugged in) moves it for real.
    this.#retuneTimer = setInterval(() => {
      if (this.#graph !== graph || graph.element.paused) return;
      this.#retune();
    }, RETUNE_INTERVAL_MS);
    return true;
  }

  pause() {
    this.#wantPlaying = false;
    this.#playRequest += 1;
    clearInterval(this.#retuneTimer);
    this.#retuneTimer = null;
    try { this.#graph?.element.pause(); } catch {}
  }

  seek(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    this.#position = value;
    if (this.#graph) this.#graph.element.currentTime = value;
    this.#changed('time');
  }

  setOffsetMs(value) {
    const ms = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(Number(value) || 0)));
    this.#offsetMs = ms;
    storeNumber(LOCAL_FILE_OFFSET_KEY, ms);
    this.#applyDelay();
    this.#changed('offset');
  }

  setMusicLevel(value) {
    const level = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(level)) return;
    this.#musicLevel = level;
    storeNumber(LOCAL_FILE_MUSIC_LEVEL_KEY, level);
    if (this.#graph) this.#graph.musicGain.gain.setTargetAtTime(level, this.#graph.context.currentTime, 0.02);
    this.#changed('level');
  }

  /** The Mic gain slider: in this mode it is applied here, not by Relay. */
  setVocalGainDb(db) {
    const value = Number(db);
    if (!Number.isFinite(value)) return;
    this.#vocalGainDb = value;
    if (this.#graph) {
      this.#graph.vocalGain.gain.setTargetAtTime(dbToGain(value), this.#graph.context.currentTime, 0.02);
    }
  }
}

export const localFileMix = new LocalFileMix();
