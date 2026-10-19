import { MicStartupGate } from './mic-startup.js';

/** @typedef {import('./mic-startup.js').MicStartupAttempt} StartupAttempt */
/** @typedef {import('./mic-capture-graph.js').MicCaptureGraph} CaptureGraph */
/** @typedef {{readonly bitrate: number, encode(pcm: ArrayBuffer, sequence: number, firstSampleIndex: number): boolean, reset(generation: number): void, setBitrate(bitrate: number): void, close(): void}} PublisherEncoder */
/** @typedef {{stream: MediaStream, context: AudioContext, encoder: PublisherEncoder | null}} PreparedCapture */
/** @typedef {PreparedCapture & {graph: CaptureGraph | null, socket: WebSocket | null}} Resources */
/** @typedef {{epoch: number, generation: number, stream: MediaStream, context: AudioContext, graph: CaptureGraph | null}} CaptureSnapshot */
/** @typedef {{epoch: number, finish(options: {releaseMic: boolean}): Promise<number>}} RetiredSession */

/**
 * Cleanup of one resource must never strand the rest of a retired session.
 * @param {() => void} operation
 */
function safely(operation) {
  try { operation(); } catch {}
}

/**
 * Owns one Mic session, including its prepared capture and physical resources.
 * Revocation is synchronous; asynchronous teardown touches only retired resources.
 * A stable token identifies terminal transactions even after the epoch is revoked.
 * DOM presentation, capture policy and transport protocols stay with their callers.
 */
export class PublisherSession {
  /** @type {Resources | null} */
  #resources = null;
  /** @type {StartupAttempt | null} */
  #attempt = null;
  #token = {};
  #epoch = 0;
  #graphEpoch = 0;
  // A page reload must not reuse the previous publisher's capture generation.
  #generation = Date.now() >>> 0;
  #generationReason = 'page-initialized';
  /** @type {Promise<boolean> | null} */
  #recovery = null;
  /** @type {Promise<void> | null} */
  #startRequest = null;
  /** @type {RetiredSession | null} */
  #retired = null;
  /** @type {WeakMap<object, Promise<boolean>>} */
  #endings = new WeakMap();
  /** @type {() => void} */
  #closeMedia;
  /** @type {MicStartupGate} */
  #startup;

  /** @param {{closeMedia: () => void, startup?: MicStartupGate}} options */
  constructor({ closeMedia, startup = new MicStartupGate() }) {
    this.#startup = startup;
    this.#closeMedia = closeMedia;
  }

  get startup() { return this.#startup; }
  get epoch() { return this.#epoch; }
  get active() { return this.#resources !== null; }
  get starting() { return this.#attempt !== null && this.startup.isCurrent(this.#attempt); }
  get context() { return this.#resources?.context ?? null; }
  get stream() { return this.#resources?.stream ?? null; }
  get encoder() { return this.#resources?.encoder ?? null; }
  get socket() { return this.#resources?.socket ?? null; }
  get graph() { return this.#resources?.graph ?? null; }
  get graphEpoch() { return this.#graphEpoch; }
  get generation() { return this.#generation; }
  get generationReason() { return this.#generationReason; }
  get recovering() { return this.#recovery !== null; }

  beginStartup() {
    if (this.active) throw new Error('Stop the active Mic before starting another.');
    this.#epoch += 1;
    this.#token = {};
    this.#retired = null;
    this.#recovery = null;
    this.#attempt = this.startup.begin();
    return this.#attempt;
  }

  /** @param {StartupAttempt} attempt @param {PreparedCapture} capture */
  activate(attempt, capture) {
    if (this.#attempt !== attempt || !this.startup.complete(attempt)) return null;
    this.#attempt = null;
    this.#resources = { ...capture, graph: null, socket: null };
    return this.#epoch;
  }

  /** @param {string} reason */
  advanceGeneration(reason) {
    this.#generation = (this.#generation + 1) >>> 0;
    this.#generationReason = reason;
    return this.#generation;
  }

  /** @param {number} epoch */
  isCurrentSession(epoch) {
    return this.active && this.#epoch === epoch;
  }

  /** @param {number} epoch @param {number} generation */
  isCurrentCapture(epoch, generation) {
    return this.isCurrentSession(epoch) && this.#generation === (generation >>> 0);
  }

  /** @param {CaptureGraph | null} graph */
  isCurrentGraph(graph) {
    return graph !== null && this.graph === graph && this.#graphEpoch === graph.epoch
      && this.isCurrentSession(graph.sessionEpoch)
      && this.stream === graph.stream && this.context === graph.context;
  }

  /** Admit a completely constructed graph; stale preparation cleans only itself.
   * @param {number} epoch @param {CaptureGraph} graph */
  adoptGraph(epoch, graph) {
    const resources = this.#resources;
    if (!resources || !this.isCurrentSession(epoch) || graph.sessionEpoch !== epoch
        || graph.stream !== resources.stream || graph.context !== resources.context
        || graph.epoch <= this.#graphEpoch) {
      if (graph !== this.graph) safely(() => graph.dispose());
      return false;
    }
    const previous = resources.graph;
    resources.graph = graph;
    this.#graphEpoch = graph.epoch;
    if (previous && previous !== graph) safely(() => previous.dispose());
    return true;
  }

  /** @param {CaptureSnapshot} snapshot */
  #matches(snapshot) {
    return this.isCurrentCapture(snapshot.epoch, snapshot.generation)
      && this.stream === snapshot.stream && this.context === snapshot.context
      && this.graph === snapshot.graph;
  }

  /** @param {CaptureSnapshot} snapshot */
  dropGraph(snapshot) {
    if (!this.#resources || !this.#matches(snapshot)) return false;
    this.#resources.graph = null;
    if (snapshot.graph) safely(() => snapshot.graph?.dispose());
    return true;
  }

  /** The caller retains prepared context ownership when admission fails.
   * @param {CaptureSnapshot} snapshot @param {AudioContext} prepared */
  replaceContext(snapshot, prepared) {
    if (!this.#resources || !this.#matches(snapshot)) return false;
    this.#resources.context = prepared;
    this.#resources.graph = null;
    if (snapshot.graph) safely(() => snapshot.graph?.dispose());
    safely(() => { void snapshot.context.close().catch(() => {}); });
    return true;
  }

  /** @param {number} epoch @param {number} generation @param {WebSocket} socket */
  bindSocket(epoch, generation, socket) {
    if (!this.#resources || !this.isCurrentCapture(epoch, generation)) {
      if (socket !== this.socket) safely(() => socket.close());
      return false;
    }
    const previous = this.#resources.socket;
    this.#resources.socket = socket;
    if (previous && previous !== socket) safely(() => previous.close());
    return true;
  }

  /** @param {WebSocket} socket */
  detachSocket(socket) {
    if (!this.#resources || this.socket !== socket) return false;
    this.#resources.socket = null;
    return true;
  }

  /** Context and graph recovery share one operation per current capture.
   * @param {(snapshot: CaptureSnapshot, isCurrent: () => boolean) => Promise<boolean>} operation */
  recover(operation) {
    if (this.#recovery) return this.#recovery;
    const resources = this.#resources;
    if (!resources) return Promise.resolve(false);
    const snapshot = { epoch: this.#epoch, generation: this.#generation,
      stream: resources.stream, context: resources.context, graph: resources.graph };
    const current = () => this.#matches(snapshot);
    const job = Promise.resolve().then(() => current() ? operation(snapshot, current) : false);
    this.#recovery = job;
    const clear = () => { if (this.#recovery === job) this.#recovery = null; };
    job.then(clear, clear);
    return job;
  }

  /** Install deduplication before starting effects, including reentrant events.
   * @param {() => Promise<void>} operation */
  requestStart(operation) {
    if (this.#startRequest) return this.#startRequest;
    const request = Promise.resolve().then(operation);
    this.#startRequest = request;
    const clear = () => { if (this.#startRequest === request) this.#startRequest = null; };
    request.then(clear, clear);
    return request;
  }

  retire() {
    if (this.#retired) return this.#retired;
    const epoch = ++this.#epoch;
    this.#graphEpoch += 1;
    let resources = this.#resources;
    const attempt = this.#attempt;
    this.#resources = null;
    this.#attempt = null;
    this.#recovery = null;
    this.startup.cancel();
    // Await known prepared resources, never an unresolved permission prompt.
    const preparingCleanup = attempt ? this.startup.dispose(attempt) : Promise.resolve();
    /** @type {Promise<number> | null} */
    let closing = null;
    this.#retired = {
      epoch,
      finish: ({ releaseMic }) => {
        if (closing) return closing;
        const owned = resources;
        resources = null;
        // Register the completion before resource callbacks can reenter teardown.
        let resolveClosed = /** @type {(epoch: number) => void} */ (() => {});
        closing = new Promise(resolve => { resolveClosed = resolve; });
        const finishClose = () => {
          void preparingCleanup.then(() => resolveClosed(epoch), () => resolveClosed(epoch));
        };
        if (owned) {
          safely(() => owned.encoder?.close());
          if (releaseMic && owned.socket?.readyState === 1) {
            safely(() => owned.socket?.send(JSON.stringify({ type: 'release-mic' })));
          }
          safely(() => this.#closeMedia());
          safely(() => owned.socket?.close());
          safely(() => { for (const track of owned.stream.getTracks()) safely(() => track.stop()); });
          safely(() => owned.graph?.dispose());
          try {
            Promise.resolve(owned.context.close()).then(finishClose, finishClose);
          } catch { finishClose(); }
        } else finishClose();
        return closing;
      },
    };
    return this.#retired;
  }

  /** Emit terminal completion once, after cleanup, only for this stable session.
   * @param {{stop: () => Promise<number>, onEnded: () => void}} options */
  end({ stop, onEnded }) {
    const token = this.#token;
    const existing = this.#endings.get(token);
    if (existing) return existing;
    let stopNow = /** @type {() => void} */ (() => {});
    /** @type {Promise<number>} */
    const stopped = new Promise((resolve, reject) => {
      stopNow = () => { try { resolve(stop()); } catch (error) { reject(error); } };
    });
    const ending = stopped.then(epoch => {
      if (this.#token !== token || this.#epoch !== epoch) return false;
      onEnded();
      return true;
    });
    this.#endings.set(token, ending);
    stopNow();
    return ending;
  }
}
