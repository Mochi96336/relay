import { enforceUnprocessedCapture } from './capture-observability.js';
import { createMicCaptureGraph } from './mic-capture-graph.js';

const HEADER_BYTES = 24;
// This is only ~0.25s of native 48 kHz Int16 mono PCM, not seconds
// of stale audio queued behind an unreliable WebSocket.
const MAX_BUFFERED_BYTES = 24 * 1024;
const CLOCK_PROOF_WINDOW_MS = 5_000;
const MIN_CLOCK_RATE_RATIO = 0.75;
const MAX_CLOCK_RATE_RATIO = 1.25;

/** Relay AudioPacket v2. Sample index belongs to the NATIVE AudioWorklet
 * capture clock; dropped chunks still advance that clock. */
export function encodeChoirMicV2(pcm, generation, sequence, firstSampleIndex) {
  if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength % 2
    || !Number.isSafeInteger(firstSampleIndex) || firstSampleIndex < 0
    || !Number.isSafeInteger(firstSampleIndex + pcm.byteLength / 2)
    || !Number.isInteger(generation) || generation < 0 || generation > 0xffff_ffff
    || !Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff)
    throw new RangeError('Invalid secondary native PCM packet');
  const packet = new ArrayBuffer(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(packet);
  view.setUint16(0, 0x4c52, true); // 'RL'
  view.setUint8(2, 2); // PCM v2; NEVER Opus v3
  view.setUint8(3, 1); // Mic only; never Robot backing
  view.setUint32(4, generation, true);
  view.setUint32(8, sequence, true);
  view.setUint32(12, pcm.byteLength / 2, true);
  view.setFloat64(16, firstSampleIndex, true);
  new Uint8Array(packet, HEADER_BYTES).set(new Uint8Array(pcm));
  return packet;
}

/** A separate B AudioContext/track/Worklet with no connection to N=1.
 * Mic permission is requested ONLY from the user's "Connect second Mic"
 * gesture, before any short-lived room claim is issued.
 */
export class ChoirSecondaryCapture {
  constructor(onFailure = () => {}) {
    this.onFailure = onFailure;
    this.epoch = 0;
    this.stream = null;
    this.context = null;
    this.graph = null;
    this.socket = null;
    this.rate = null;
    this.generation = null;
    this.cursor = 0;
    this.sequence = 0;
    this.track = null;
    this.clockWallOriginMs = null;
    this.clockSampleOrigin = 0;
  }

  async prepare() {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('HTTPS microphone required');
    const epoch = this.epoch;
    // Establish the AudioContext during the actual click gesture on iOS.
    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;
    // Invoke resume() in the SAME user gesture, before the asynchronous
    // permission dialog consumes transient activation (notably on iOS).
    // Full graph readiness is checked again after the worklet is installed.
    void context.resume().catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false,
          noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      if (this.epoch !== epoch) {
        stream.getTracks().forEach(track => track.stop());
        return null;
      }
      this.stream = stream;
      await enforceUnprocessedCapture(stream);
      if (this.epoch !== epoch) return null;
      const rate = context.sampleRate;
      if (!Number.isSafeInteger(rate) || rate < 8_000 || rate > 192_000)
        throw new Error('Invalid capture sample rate');
      await context.audioWorklet.addModule('/capture-worklet.js');
      if (this.epoch !== epoch) return null;
      await context.resume();
      if (this.epoch !== epoch || context.state !== 'running')
        throw new Error('Capture AudioContext is not running');
      const generation = new Uint32Array(1);
      crypto.getRandomValues(generation);
      this.generation = generation[0] || 1;
      this.rate = rate;
      this.cursor = 0;
      this.sequence = 0;
      this.clockWallOriginMs = null;
      this.clockSampleOrigin = 0;
      this.track = stream.getAudioTracks()[0] ?? null;
      if (!this.track || this.track.readyState !== 'live'
        || this.track.muted) throw new Error('Microphone track unavailable');
      const revoke = () => { if (this.epoch === epoch) this.fail('capture-route-changed'); };
      this.track.addEventListener('ended', revoke, { once: true });
      this.track.addEventListener('mute', revoke, { once: true });
      context.addEventListener('statechange', () => {
        if (this.epoch === epoch && context.state !== 'running') revoke();
      });
      this.graph = createMicCaptureGraph({
        epoch, sessionEpoch: epoch, stream, context,
        isCurrent: () => this.epoch === epoch,
        onCaptureMessage: (event, graph) => this.onCapture(event, graph, epoch),
        onProcessorError: () => revoke(),
        onInputDeviceChanged: () => revoke(),
        onInputDeviceRemoved: () => revoke(),
        // No visual DSP worker in the experimental secondary path.
        WorkerClass: null,
      });
      return rate;
    } catch (error) {
      if (this.epoch === epoch) this.stop();
      else stream?.getTracks().forEach(track => track.stop());
      throw error;
    }
  }

  /**
   * Which capture sample was being recorded at `sampledAtPerformanceMs`, as
   * the main Mic's sample/song anchor (app.js) computes it: the server maps
   * it against B's local YouTube position for YouTube-time alignment.
   */
  anchorFor(sampledAtPerformanceMs) {
    const anchor = this.lastChunk;
    if (!anchor || !this.context || this.context.state !== 'running' || this.rate === null) return null;
    const now = performance.now();
    const age = now - anchor.observedAt;
    if (age < 0 || age > 250) return null;
    if (!Number.isFinite(sampledAtPerformanceMs)
      || now - sampledAtPerformanceMs < 0 || now - sampledAtPerformanceMs > 100) return null;
    const index = anchor.firstSampleIndex
      + (this.context.currentTime - anchor.contextTime + (sampledAtPerformanceMs - now) / 1000) * this.rate;
    if (!Number.isFinite(index)) return null;
    return {
      generation: this.generation, sampleRate: this.rate, sampleIndex: anchor.firstSampleIndex,
      mediaDeltaSeconds: (anchor.firstSampleIndex - index) / this.rate, uncertaintyMs: 40,
    };
  }

  attach(socket, sampleRate) {
    if (!this.graph || !this.context || this.context.state !== 'running'
      || !this.track || this.track.readyState !== 'live' || this.track.muted
      || sampleRate !== this.rate || socket.readyState !== WebSocket.OPEN)
      return false;
    this.socket = socket;
    return true;
  }

  onCapture(event, graph, epoch) {
    if (this.epoch !== epoch || this.graph !== graph) return;
    const value = event.data instanceof ArrayBuffer
      ? { buffer: event.data, capturedAtContextTime: null }
      : event.data?.type === 'pcm' && event.data.buffer instanceof ArrayBuffer
        ? event.data : null;
    if (event.data?.type === 'input-gap'
      && event.data.reason !== 'digital-silence') {
      this.fail('input-gap');
      return;
    }
    if (!value) return;
    const pcm = value.buffer;
    // Own the Worklet buffer before doing any fallible clock or network work.
    // A capture-clock failure stops the graph, but must still exit this scope.
    try {
      const samples = pcm.byteLength / 2;
      const firstSampleIndex = this.cursor;
      // ALWAYS advance native cursor even if WebSocket is late/disconnected.
      this.cursor += samples;
      const nowMs = performance.now();
      if (this.clockWallOriginMs === null) {
        this.clockWallOriginMs = nowMs;
        this.clockSampleOrigin = this.cursor;
      } else {
        const elapsedMs = nowMs - this.clockWallOriginMs;
        if (elapsedMs >= CLOCK_PROOF_WINDOW_MS) {
          const capturedSamples = this.cursor - this.clockSampleOrigin;
          const clockRateRatio = (capturedSamples / this.rate) / (elapsedMs / 1000);
          if (!Number.isFinite(clockRateRatio)
            || clockRateRatio < MIN_CLOCK_RATE_RATIO
            || clockRateRatio > MAX_CLOCK_RATE_RATIO) {
            this.fail('capture-clock-diverged');
            return;
          }
          // Periodically re-anchor after healthy evidence; a long singer
          // session never grows into a lifetime-average hiding a fresh stall.
          this.clockWallOriginMs = nowMs;
          this.clockSampleOrigin = this.cursor;
        }
      }
      if (Number.isFinite(value.capturedAtContextTime)) {
        this.lastChunk = { firstSampleIndex, contextTime: value.capturedAtContextTime, observedAt: nowMs };
      }
      const age = Number.isFinite(value.capturedAtContextTime)
        ? this.context.currentTime - value.capturedAtContextTime : Infinity;
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN
        || socket.bufferedAmount > MAX_BUFFERED_BYTES
        || !Number.isFinite(age) || age > 0.2 || age < -0.05
        || !samples || samples > Math.ceil(this.rate * .2)) return;
      const packet = encodeChoirMicV2(
        pcm, this.generation, this.sequence, firstSampleIndex,
      );
      socket.send(packet);
      this.sequence = (this.sequence + 1) >>> 0;
    } finally {
      // The audio thread owns its own recycled chunk buffer; return after
      // all packet bytes have been copied, never while encoding it.
      // The original graph is responsible for rejecting returns after dispose.
      // Do not test this.epoch: fail() increments it before this finally runs.
      graph.returnBuffer(pcm);
    }
  }

  fail(reason) {
    this.stop();
    this.onFailure(reason);
  }

  stop() {
    ++this.epoch;
    this.socket = null;
    this.graph?.dispose();
    this.graph = null;
    this.track = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    const ctx = this.context;
    this.context = null;
    if (ctx) void ctx.close().catch(() => {});
    this.rate = null;
    this.generation = null;
    this.clockWallOriginMs = null;
    this.clockSampleOrigin = 0;
    this.lastChunk = null;
  }
}
