/**
 * Wire format for microphone and captured-source PCM.
 *
 * Relay used to align the two streams purely by counting the samples that
 * arrived, so a dropped frame, a congested uplink or a reconnect silently
 * compressed the timeline and there was no way to notice. Each frame now states
 * where it belongs, which makes gaps explicit and lets a stream survive a
 * transport interruption without resetting the mix.
 *
 * ```text
 * offset  size  field
 *      0     2  magic 'RL' (uint16 LE)
 *      2     1  version
 *      3     1  flags (reserved, 0)
 *      4     4  generation (uint32 LE) - a contiguous capture session
 *      8     8  firstSampleIndex (float64 LE) - in the SOURCE's sample rate,
 *               counted from the start of that capture session
 *     16     n  Int16 LE mono PCM
 * ```
 *
 * `firstSampleIndex` is a float64 rather than a uint64 so both ends can treat it
 * as an ordinary number; it stays exact past 2^53 samples, which is millennia at
 * 48 kHz. The browser encoders in `public/app.js` and the Chrome extension's
 * `offscreen.js` write this same layout by hand - `test/pcm-frame.test.ts` pins
 * the byte offsets so the two cannot drift apart unnoticed.
 */

export const FRAME_MAGIC = 0x4c52; // 'RL' as uint16 LE
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 16;

export type PcmFrame = {
  /** Null for a frame with no header, which must fall back to frontier append. */
  generation: number | null;
  firstSampleIndex: number | null;
  pcm: Buffer;
};

export function decodePcmFrame(buffer: Buffer): PcmFrame {
  if (
    buffer.byteLength < FRAME_HEADER_BYTES ||
    buffer.readUInt16LE(0) !== FRAME_MAGIC ||
    buffer.readUInt8(2) !== FRAME_VERSION
  ) {
    return { generation: null, firstSampleIndex: null, pcm: buffer };
  }

  const firstSampleIndex = buffer.readDoubleLE(8);
  if (!Number.isFinite(firstSampleIndex) || firstSampleIndex < 0) {
    return { generation: null, firstSampleIndex: null, pcm: buffer.subarray(FRAME_HEADER_BYTES) };
  }

  return {
    generation: buffer.readUInt32LE(4),
    firstSampleIndex,
    pcm: buffer.subarray(FRAME_HEADER_BYTES),
  };
}

export function encodePcmFrame(generation: number, firstSampleIndex: number, pcm: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + pcm.byteLength);
  frame.writeUInt16LE(FRAME_MAGIC, 0);
  frame.writeUInt8(FRAME_VERSION, 2);
  frame.writeUInt8(0, 3);
  frame.writeUInt32LE(generation >>> 0, 4);
  frame.writeDoubleLE(firstSampleIndex, 8);
  pcm.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}
