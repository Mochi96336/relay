import { readFile } from 'node:fs/promises';
import { createOpusEncoder } from '../../public/mic-opus-worker.js';
import type { AudioPacket } from '../../src/audio-packet.js';

export const OPUS_FRAME_SAMPLES = 960;

export async function micOpusEncoder(bitrate = 128_000) {
  return createOpusEncoder(await readFile(
    new URL('../../node_modules/@evan/opus/wasm/opus.wasm', import.meta.url)), bitrate);
}

/** Quiet raw singing, before the room's Mic gain: sensitive to decoder resets. */
export function quietVowelFrames(count: number): ArrayBuffer[] {
  let phase = 0;
  return Array.from({ length: count }, (_, frame) => {
    const pcm = new Int16Array(OPUS_FRAME_SAMPLES);
    for (let j = 0; j < pcm.length; j++) {
      const i = frame * pcm.length + j;
      phase += 2 * Math.PI * 262 * (1 + .012 * Math.sin(2 * Math.PI * 5.5 * i / 48_000)) / 48_000;
      let value = 0;
      for (let h = 1; h * 262 < 8_000; h++) {
        value += (1 + 4 * Math.exp(-(((h * 262 - 700) / 150) ** 2))) / h * Math.sin(h * phase);
      }
      pcm[j] = Math.round(value * 90);
    }
    return pcm.buffer;
  });
}

export async function encodeMicOpus(
  frames: readonly ArrayBuffer[],
  { bitrate = 128_000, skip = new Set<number>(), firstSequence = 0 } = {},
): Promise<AudioPacket[]> {
  const encoder = await micOpusEncoder(bitrate);
  let sequence = firstSequence;
  return frames.flatMap((pcm, index) => skip.has(index) ? [] : [{
    source: 'mic' as const, generation: 7, sequence: sequence++ >>> 0,
    firstSampleIndex: index * OPUS_FRAME_SAMPLES, sampleCount: OPUS_FRAME_SAMPLES,
    opusDelaySamples: encoder.delaySamples, pcm: Buffer.from(encoder.encode(pcm)),
  }]);
}

/** The production Mic worker's v3 envelope, also understood by Choir B. */
export function opusPacketBytes(packet: AudioPacket): Buffer {
  const bytes = Buffer.alloc(28 + packet.pcm.byteLength);
  bytes.writeUInt16LE(0x4c52, 0); bytes[2] = 3; bytes[3] = 1;
  bytes.writeUInt32LE(packet.generation, 4); bytes.writeUInt32LE(packet.sequence, 8);
  bytes.writeUInt32LE(packet.sampleCount, 12); bytes.writeDoubleLE(packet.firstSampleIndex, 16);
  bytes.writeUInt16LE(packet.opusDelaySamples!, 24); bytes.set(packet.pcm, 28);
  return bytes;
}
