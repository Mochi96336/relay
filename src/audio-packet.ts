/**
 * Transport-neutral PCM packet used by Relay's media plane.
 *
 * Time belongs to the capture timeline, not to the transport. `sequence`
 * describes packet order for loss/reorder evidence; `firstSampleIndex`
 * describes where the audio belongs even when packets arrive late or not at
 * all.
 *
 * ```text
 * offset  size  field
 *      0     2  magic 'RL' (uint16 LE)
 *      2     1  version = 2
 *      3     1  source (1 mic, 2 backing)
 *      4     4  generation (uint32 LE)
 *      8     4  sequence (uint32 LE)
 *     12     4  sampleCount (uint32 LE)
 *     16     8  firstSampleIndex (float64 LE)
 *     24     n  Int16 LE mono PCM
 * ```
 */

export const AUDIO_PACKET_MAGIC = 0x4c52;
export const AUDIO_PACKET_VERSION = 2;
export const AUDIO_PACKET_HEADER_BYTES = 24;

export type AudioPacketSource = 'mic' | 'backing';

export type AudioPacket = {
  source: AudioPacketSource;
  generation: number;
  sequence: number;
  firstSampleIndex: number;
  sampleCount: number;
  pcm: Buffer;
};

export type AudioPacketDecodeError =
  | 'too-short'
  | 'bad-magic'
  | 'unsupported-version'
  | 'unknown-source'
  | 'invalid-sample-count'
  | 'invalid-sample-range'
  | 'payload-length-mismatch';

export type AudioPacketDecodeResult =
  | { ok: true; packet: AudioPacket }
  | { ok: false; error: AudioPacketDecodeError };

function sourceByte(source: AudioPacketSource) {
  return source === 'mic' ? 1 : 2;
}

function decodeSource(value: number): AudioPacketSource | null {
  if (value === 1) return 'mic';
  if (value === 2) return 'backing';
  return null;
}

function validUint32(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validSampleRange(firstSampleIndex: number, sampleCount: number) {
  return Number.isSafeInteger(firstSampleIndex)
    && firstSampleIndex >= 0
    && Number.isSafeInteger(firstSampleIndex + sampleCount)
    && firstSampleIndex + sampleCount <= Number.MAX_SAFE_INTEGER;
}

export function decodeAudioPacket(buffer: Buffer): AudioPacketDecodeResult {
  if (buffer.byteLength < AUDIO_PACKET_HEADER_BYTES) return { ok: false, error: 'too-short' };
  if (buffer.readUInt16LE(0) !== AUDIO_PACKET_MAGIC) return { ok: false, error: 'bad-magic' };
  if (buffer.readUInt8(2) !== AUDIO_PACKET_VERSION) return { ok: false, error: 'unsupported-version' };

  const source = decodeSource(buffer.readUInt8(3));
  if (!source) return { ok: false, error: 'unknown-source' };

  const generation = buffer.readUInt32LE(4);
  const sequence = buffer.readUInt32LE(8);
  const sampleCount = buffer.readUInt32LE(12);
  const firstSampleIndex = buffer.readDoubleLE(16);

  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    return { ok: false, error: 'invalid-sample-count' };
  }
  if (!validSampleRange(firstSampleIndex, sampleCount)) {
    return { ok: false, error: 'invalid-sample-range' };
  }

  const payloadBytes = buffer.byteLength - AUDIO_PACKET_HEADER_BYTES;
  if (payloadBytes !== sampleCount * 2) {
    return { ok: false, error: 'payload-length-mismatch' };
  }

  return {
    ok: true,
    packet: {
      source,
      generation,
      sequence,
      firstSampleIndex,
      sampleCount,
      pcm: buffer.subarray(AUDIO_PACKET_HEADER_BYTES),
    },
  };
}

export function encodeAudioPacket(input: Omit<AudioPacket, 'sampleCount'>): Buffer {
  if (!validUint32(input.generation)) throw new RangeError('generation must be a uint32');
  if (!validUint32(input.sequence)) throw new RangeError('sequence must be a uint32');
  if (input.pcm.byteLength === 0 || input.pcm.byteLength % 2 !== 0) {
    throw new RangeError('PCM payload must contain one or more Int16 samples');
  }

  const sampleCount = input.pcm.byteLength / 2;
  if (!validSampleRange(input.firstSampleIndex, sampleCount)) {
    throw new RangeError('invalid sample range');
  }

  const packet = Buffer.allocUnsafe(AUDIO_PACKET_HEADER_BYTES + input.pcm.byteLength);
  packet.writeUInt16LE(AUDIO_PACKET_MAGIC, 0);
  packet.writeUInt8(AUDIO_PACKET_VERSION, 2);
  packet.writeUInt8(sourceByte(input.source), 3);
  packet.writeUInt32LE(input.generation >>> 0, 4);
  packet.writeUInt32LE(input.sequence >>> 0, 8);
  packet.writeUInt32LE(sampleCount, 12);
  packet.writeDoubleLE(input.firstSampleIndex, 16);
  input.pcm.copy(packet, AUDIO_PACKET_HEADER_BYTES);
  return packet;
}
