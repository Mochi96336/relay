import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AudioPacket } from './audio-packet.js';

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

type OpusWasm = {
  memory: WebAssembly.Memory;
  malloc(bytes: number): number;
  free(pointer: number): void;
  opus_decoder_get_size(channels: number): number;
  opus_decoder_init(state: number, sampleRate: number, channels: number): number;
  opus_decode(state: number, data: number, length: number, pcm: number, frameSize: number, fec: number): number;
};

export type OpusMicDecoderStats = {
  decodedPackets: number;
  concealedPackets: number;
  decodeFailures: number;
};

/** Pure placement metadata, usable for admission before a decoder is touched. */
export function opusMicSampleSpan(packet: Pick<AudioPacket, 'firstSampleIndex' | 'sampleCount' | 'opusDelaySamples'>) {
  if (packet.opusDelaySamples === undefined || packet.sampleCount !== OPUS_MIC_FRAME_SAMPLES)
    throw new TypeError('Expected a 20 ms Mic Opus packet');
  const start = packet.firstSampleIndex - packet.opusDelaySamples;
  const trimSamples = Math.max(0, -start);
  return { firstSampleIndex: Math.max(0, start), sampleCount: packet.sampleCount - trimSamples, trimSamples };
}

type OpusMicFrame = { generation: number; firstSampleIndex: number; pcm: Buffer };

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
  private readonly checkpoint: Uint8Array;
  private nextSequence: number | null = null;
  private readonly counters: OpusMicDecoderStats = { decodedPackets: 0, concealedPackets: 0, decodeFailures: 0 };

  constructor() {
    const { wasm } = opus();
    this.checkpoint = new Uint8Array(wasm.opus_decoder_get_size(1));
    this.state = wasm.malloc(this.checkpoint.length);
    const code = wasm.opus_decoder_init(this.state, 48_000, 1);
    if (code < 0) {
      wasm.free(this.state);
      throw new Error(`Opus decoder init failed (${code})`);
    }
    released.register(this, this.state);
  }

  /**
   * One admitted, ordered packet of this capture. Sequence counts encoder
   * calls; capture positions include PCM discarded BEFORE encoding, which
   * must not advance the decoder. Only missing encoded packets need PLC.
   * A capture replacement owns a new decoder; a late packet never resets it.
   */
  decode(packet: AudioPacket): OpusMicFrame | null {
    const span = opusMicSampleSpan(packet);
    if (this.nextSequence !== null) {
      const missing = (packet.sequence - this.nextSequence) >>> 0;
      if (missing >= 0x8000_0000) return null;
      this.conceal(Math.min(MAX_CONCEALED_FRAMES, missing));
    }
    this.nextSequence = (packet.sequence + 1) >>> 0;
    const pcm = this.decodePayload(packet.pcm);
    if (!pcm) return null;
    this.counters.decodedPackets++;
    if (span.sampleCount <= 0) return null;
    return { generation: packet.generation, firstSampleIndex: span.firstSampleIndex, pcm: pcm.subarray(span.trimSamples * 2) };
  }

  stats(): OpusMicDecoderStats {
    return { ...this.counters };
  }

  private decodePayload(payload: Uint8Array): Buffer | null {
    const { wasm, input, output } = opus();
    if (payload.byteLength >= 1 && payload.byteLength <= 1_275) {
      // libopus state is position-independent contiguous memory (opus.h).
      // Decode is transactional: even a valid packet of the wrong duration
      // must not leave half a frame's history serving the next good packet.
      this.checkpoint.set(new Uint8Array(wasm.memory.buffer, this.state, this.checkpoint.length));
      new Uint8Array(wasm.memory.buffer, input, payload.byteLength).set(payload);
      const samples = wasm.opus_decode(this.state, input, payload.byteLength, output, OPUS_MIC_FRAME_SAMPLES, 0);
      if (samples === OPUS_MIC_FRAME_SAMPLES)
        return Buffer.from(new Uint8Array(wasm.memory.buffer, output, samples * 2));
      new Uint8Array(wasm.memory.buffer, this.state, this.checkpoint.length).set(this.checkpoint);
    }
    this.counters.decodeFailures++;
    this.conceal(1);
    return null;
  }

  /** libopus loss concealment for `frames` lost 20 ms frames; the audio is discarded. */
  private conceal(frames: number) {
    const { wasm, output } = opus();
    for (let i = 0; i < frames; i++) {
      const samples = wasm.opus_decode(this.state, 0, 0, output, OPUS_MIC_FRAME_SAMPLES, 0);
      if (samples < 0) throw new Error(`Opus concealment failed (${samples})`);
      this.counters.concealedPackets++;
    }
  }
}
