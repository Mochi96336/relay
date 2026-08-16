import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AUDIO_PACKET_HEADER_BYTES,
  AUDIO_PACKET_MAGIC,
  AUDIO_PACKET_VERSION,
  decodeAudioPacket,
  encodeAudioPacket,
} from '../src/audio-packet.js';

function pcm(...values: number[]) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
}

describe('AudioPacket v2', () => {
  test('round-trips transport order and timeline position independently', () => {
    const encoded = encodeAudioPacket({
      source: 'mic',
      generation: 7,
      sequence: 99,
      firstSampleIndex: 123_456,
      pcm: pcm(1, -2, 3),
    });
    const decoded = decodeAudioPacket(encoded);

    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    assert.equal(decoded.packet.source, 'mic');
    assert.equal(decoded.packet.generation, 7);
    assert.equal(decoded.packet.sequence, 99);
    assert.equal(decoded.packet.firstSampleIndex, 123_456);
    assert.equal(decoded.packet.sampleCount, 3);
    assert.deepEqual([...new Int16Array(
      decoded.packet.pcm.buffer,
      decoded.packet.pcm.byteOffset,
      decoded.packet.sampleCount,
    )], [1, -2, 3]);
  });

  test('pins the v2 byte layout', () => {
    const encoded = encodeAudioPacket({
      source: 'backing',
      generation: 0xdeadbeef,
      sequence: 0xffff_fffe,
      firstSampleIndex: 2 ** 40 + 5,
      pcm: pcm(-32768, 32767),
    });

    assert.equal(AUDIO_PACKET_HEADER_BYTES, 24);
    assert.equal(encoded.readUInt16LE(0), AUDIO_PACKET_MAGIC);
    assert.equal(encoded.readUInt8(2), AUDIO_PACKET_VERSION);
    assert.equal(encoded.readUInt8(3), 2);
    assert.equal(encoded.readUInt32LE(4), 0xdeadbeef);
    assert.equal(encoded.readUInt32LE(8), 0xffff_fffe);
    assert.equal(encoded.readUInt32LE(12), 2);
    assert.equal(encoded.readDoubleLE(16), 2 ** 40 + 5);
    assert.equal(encoded.readInt16LE(24), -32768);
    assert.equal(encoded.readInt16LE(26), 32767);
  });

  test('rejects malformed v2 packets instead of treating them as raw PCM', () => {
    const good = encodeAudioPacket({
      source: 'mic', generation: 1, sequence: 2, firstSampleIndex: 10, pcm: pcm(1, 2),
    });

    assert.deepEqual(decodeAudioPacket(good.subarray(0, 10)), { ok: false, error: 'too-short' });

    const badMagic = Buffer.from(good);
    badMagic.writeUInt16LE(0x1234, 0);
    assert.deepEqual(decodeAudioPacket(badMagic), { ok: false, error: 'bad-magic' });

    const badVersion = Buffer.from(good);
    badVersion.writeUInt8(99, 2);
    assert.deepEqual(decodeAudioPacket(badVersion), { ok: false, error: 'unsupported-version' });

    const badSource = Buffer.from(good);
    badSource.writeUInt8(9, 3);
    assert.deepEqual(decodeAudioPacket(badSource), { ok: false, error: 'unknown-source' });

    const wrongCount = Buffer.from(good);
    wrongCount.writeUInt32LE(99, 12);
    assert.deepEqual(decodeAudioPacket(wrongCount), { ok: false, error: 'payload-length-mismatch' });
  });

  test('rejects invalid sample ranges', () => {
    const packet = encodeAudioPacket({
      source: 'mic', generation: 1, sequence: 1, firstSampleIndex: 0, pcm: pcm(1),
    });

    const fractional = Buffer.from(packet);
    fractional.writeDoubleLE(1.5, 16);
    assert.deepEqual(decodeAudioPacket(fractional), { ok: false, error: 'invalid-sample-range' });

    const negative = Buffer.from(packet);
    negative.writeDoubleLE(-1, 16);
    assert.deepEqual(decodeAudioPacket(negative), { ok: false, error: 'invalid-sample-range' });

    const overflow = Buffer.from(packet);
    overflow.writeDoubleLE(Number.MAX_SAFE_INTEGER, 16);
    assert.deepEqual(decodeAudioPacket(overflow), { ok: false, error: 'invalid-sample-range' });
  });
});
