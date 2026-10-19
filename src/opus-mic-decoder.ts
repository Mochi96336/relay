import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * One Mic's Opus decoder: libopus from the same opus.wasm the page's encoder
 * runs (public/mic-opus-worker.js), driven directly because @evan/opus's
 * Decoder cannot run packet-loss concealment (it refuses an empty packet).
 *
 * Why a lost packet is concealed, never reset: Opus codes each frame's band
 * energies relative to the frame before it, and the page's encoder keeps going
 * across a packet the network lost. A decoder reset at the hole restarts from
 * default energies instead. For a quiet raw Mic (most singers, lifted by the
 * Mic gain) the frames after the hole then decode several dB too loud,
 * converging over about 100 ms: a "pop" at every lost packet. Running libopus
 * concealment for each lost frame keeps the decoder's state continuous with
 * the encoder's. That output only advances the state and is discarded: the
 * hole stays a hole in the timeline, concealed and counted downstream exactly
 * as before.
 */
const OPUS_MIC_FRAME_SAMPLES = 960;
/** Concealment fades to silence well within this; a longer hole needs no more. */
const MAX_CONCEALED_FRAMES = 50;
const OPUS_RESET_STATE = 4028;

type OpusWasm = {
  memory: WebAssembly.Memory;
  malloc(bytes: number): number;
  free(pointer: number): void;
  opus_decoder_get_size(channels: number): number;
  opus_decoder_init(state: number, sampleRate: number, channels: number): number;
  opus_decode(state: number, data: number, length: number, pcm: number, frameSize: number, fec: number): number;
  opus_decoder_ctl_set(state: number, request: number, value: number): number;
};

let shared: { wasm: OpusWasm; input: number; output: number } | null = null;
function opus() {
  if (!shared) {
    const file = createRequire(import.meta.url).resolve('@evan/opus/wasm/opus.wasm');
    const wasm = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(file)), {
      wasi_snapshot_preview1: { fd_seek() {}, fd_write() {}, fd_close() {}, proc_exit() {} },
      env: { emscripten_notify_memory_growth() {} },
    }).exports as unknown as OpusWasm;
    // One process-wide scratch pair: decoding is synchronous.
    shared = { wasm, input: wasm.malloc(1_500), output: wasm.malloc(OPUS_MIC_FRAME_SAMPLES * 2) };
  }
  return shared;
}

const released = new FinalizationRegistry<number>((state) => shared?.wasm.free(state));

export class OpusMicDecoder {
  private readonly state: number;
  /** Capture sample just past the last packet decoded; null before the first. */
  private end: number | null = null;

  constructor() {
    const { wasm } = opus();
    this.state = wasm.malloc(wasm.opus_decoder_get_size(1));
    const code = wasm.opus_decoder_init(this.state, 48_000, 1);
    if (code < 0) {
      wasm.free(this.state);
      throw new Error(`Opus decoder init failed (${code})`);
    }
    released.register(this, this.state);
  }

  /**
   * Decodes the 20 ms packet whose capture frame starts at `firstSampleIndex`.
   * Across a forward hole of whole frames the lost frames are concealed first;
   * anything else (overlap, a partial frame) starts the stream over.
   */
  decodeAt(firstSampleIndex: number, payload: Uint8Array): Buffer {
    if (this.end !== null && firstSampleIndex !== this.end) {
      const missing = firstSampleIndex - this.end;
      if (missing > 0 && missing % OPUS_MIC_FRAME_SAMPLES === 0) {
        this.conceal(Math.min(MAX_CONCEALED_FRAMES, missing / OPUS_MIC_FRAME_SAMPLES));
      } else {
        this.reset();
      }
    }
    const pcm = this.decode(payload);
    this.end = firstSampleIndex + OPUS_MIC_FRAME_SAMPLES;
    return pcm;
  }

  private decode(payload: Uint8Array): Buffer {
    const { wasm, input, output } = opus();
    if (payload.byteLength < 1 || payload.byteLength > 1_500) throw new Error('Invalid Opus packet size');
    new Uint8Array(wasm.memory.buffer, input, payload.byteLength).set(payload);
    const samples = wasm.opus_decode(this.state, input, payload.byteLength, output, OPUS_MIC_FRAME_SAMPLES, 0);
    if (samples !== OPUS_MIC_FRAME_SAMPLES) throw new Error(`Opus decode failed (${samples})`);
    return Buffer.from(new Uint8Array(wasm.memory.buffer, output, samples * 2));
  }

  /** libopus loss concealment for `frames` lost 20 ms frames; the audio is discarded. */
  private conceal(frames: number) {
    const { wasm, output } = opus();
    for (let i = 0; i < frames; i++) {
      const samples = wasm.opus_decode(this.state, 0, 0, output, OPUS_MIC_FRAME_SAMPLES, 0);
      if (samples < 0) throw new Error(`Opus concealment failed (${samples})`);
    }
  }

  private reset() {
    shared?.wasm.opus_decoder_ctl_set(this.state, OPUS_RESET_STATE, 0);
  }
}
