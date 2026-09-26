/**
 * Opus for the Listen downlink.
 *
 * Every Listen page receives the room mix as 48 kHz mono PCM16: about
 * 800 kbps per listener over TCP, through whatever tunnel or proxy sits in
 * front of Relay. On a mobile link that is most of the difference between a
 * listener that keeps up and one that stalls. Opus at 96 kbps carries a 20 ms
 * mix frame in about 240 bytes instead of 1,936.
 *
 * Relay encodes each mix frame once, for every listener that negotiated it
 * (a page whose WebCodecs AudioDecoder supports Opus). Other pages keep PCM.
 * The feature is off unless RELAY_LISTEN_OPUS=1, and only then is the codec
 * loaded at all.
 *
 * ```text
 * offset  size  field
 *      0     2  magic 'RL' (uint16 LE)
 *      2     1  version = 2 (a codec frame; version 1 is positioned PCM)
 *      3     1  codec (1 = Opus)
 *      4     4  mix generation (uint32 LE)
 *      8     8  firstSampleIndex (float64 LE), in mix samples
 *     16     4  sampleCount (uint32 LE): mix samples the payload decodes to
 *     20     n  one Opus packet
 * ```
 */

import { FRAME_MAGIC } from './pcm-frame.js';

export const MONITOR_CODEC_FRAME_VERSION = 2;
export const MONITOR_CODEC_OPUS = 1;
export const MONITOR_CODEC_FRAME_HEADER_BYTES = 20;

export type MonitorOpusEncoder = {
  /** One mix frame of Int16 LE PCM in, one Opus packet out. */
  encode(pcm: Buffer): Uint8Array;
  /** Forgets prediction state, for a frame that does not follow the last one. */
  reset(): void;
};

export function encodeMonitorOpusFrame(
  generation: number,
  firstSampleIndex: number,
  sampleCount: number,
  packet: Uint8Array,
) {
  const frame = Buffer.allocUnsafe(MONITOR_CODEC_FRAME_HEADER_BYTES + packet.byteLength);
  frame.writeUInt16LE(FRAME_MAGIC, 0);
  frame.writeUInt8(MONITOR_CODEC_FRAME_VERSION, 2);
  frame.writeUInt8(MONITOR_CODEC_OPUS, 3);
  frame.writeUInt32LE(generation >>> 0, 4);
  frame.writeDoubleLE(firstSampleIndex, 8);
  frame.writeUInt32LE(sampleCount, 16);
  frame.set(packet, MONITOR_CODEC_FRAME_HEADER_BYTES);
  return frame;
}

export type MonitorOpusOptions = {
  sampleRate: number;
  bitrate: number;
};

/**
 * Loads the Opus encoder for the room mix. Rejects when the codec cannot be
 * loaded on this host; callers then keep every listener on PCM.
 */
export async function loadMonitorOpusEncoder(options: MonitorOpusOptions): Promise<MonitorOpusEncoder> {
  if (options.sampleRate !== 48_000) {
    throw new Error('Listen Opus expects the 48 kHz mix.');
  }
  const { Encoder } = await import('@evan/opus');
  const encoder = new Encoder({ channels: 1, sample_rate: 48_000, application: 'audio' });
  encoder.bitrate = options.bitrate;
  // The room mix is mostly a song, and listeners hear it over TCP: no packet
  // is ever lost in transit, so in-band FEC would only cost bitrate.
  encoder.signal = 'music';
  encoder.inband_fec = false;
  return {
    encode: (pcm) => encoder.encode(pcm),
    reset: () => encoder.reset(),
  };
}
