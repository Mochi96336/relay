import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_VERSION,
  decodePcmFrame,
  encodePcmFrame,
} from '../src/pcm-frame.js';

function pcm(...values: number[]) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => buffer.writeInt16LE(value, i * 2));
  return buffer;
}

describe('pcm frame', () => {
  test('round-trips generation, index and payload', () => {
    const frame = encodePcmFrame(7, 123_456, pcm(1, -2, 3));
    const decoded = decodePcmFrame(frame);

    assert.equal(decoded.generation, 7);
    assert.equal(decoded.firstSampleIndex, 123_456);
    assert.deepEqual([...new Int16Array(decoded.pcm.buffer, decoded.pcm.byteOffset, 3)], [1, -2, 3]);
  });

  // public/app.js and the Chrome extension's offscreen.js write this layout by
  // hand with a DataView, because neither can import the module. If these
  // offsets ever move, those two hand-written encoders break silently.
  test('pins the byte layout the browser encoders duplicate', () => {
    const frame = encodePcmFrame(0xdeadbeef, 2 ** 40 + 5, pcm(-32768, 32767));

    assert.equal(FRAME_HEADER_BYTES, 16);
    assert.equal(frame.byteLength, 16 + 4);
    assert.equal(frame.readUInt16LE(0), FRAME_MAGIC);
    assert.equal(frame.readUInt8(2), FRAME_VERSION);
    assert.equal(frame.readUInt8(3), 0, 'flags are reserved and must stay zero');
    assert.equal(frame.readUInt32LE(4), 0xdeadbeef);
    assert.equal(frame.readDoubleLE(8), 2 ** 40 + 5);
    assert.equal(frame.readInt16LE(16), -32768);
    assert.equal(frame.readInt16LE(18), 32767);
  });

  test('keeps a sample index exact far beyond any real session', () => {
    // 2^53 samples is millennia at 48 kHz; the point is that float64 never
    // rounds an index within any plausible range.
    for (const index of [0, 1, 48_000, 2 ** 32, 2 ** 45, Number.MAX_SAFE_INTEGER]) {
      assert.equal(decodePcmFrame(encodePcmFrame(1, index, pcm(0))).firstSampleIndex, index);
    }
  });

  test('treats a frame with no header as unpositioned', () => {
    const raw = pcm(5, 6, 7, 8, 9, 10, 11, 12, 13, 14);
    const decoded = decodePcmFrame(raw);

    assert.equal(decoded.generation, null);
    assert.equal(decoded.firstSampleIndex, null);
    assert.equal(decoded.pcm.byteLength, raw.byteLength, 'the payload must survive intact');
  });

  test('rejects a wrong magic or version rather than misreading it', () => {
    const wrongMagic = encodePcmFrame(1, 10, pcm(1, 2));
    wrongMagic.writeUInt16LE(0x1234, 0);
    assert.equal(decodePcmFrame(wrongMagic).firstSampleIndex, null);

    const wrongVersion = encodePcmFrame(1, 10, pcm(1, 2));
    wrongVersion.writeUInt8(99, 2);
    assert.equal(decodePcmFrame(wrongVersion).firstSampleIndex, null);
  });

  test('rejects a corrupt sample index but keeps the audio', () => {
    const frame = encodePcmFrame(1, 10, pcm(1, 2, 3));
    frame.writeDoubleLE(Number.NaN, 8);
    const decoded = decodePcmFrame(frame);

    assert.equal(decoded.firstSampleIndex, null);
    assert.equal(decoded.pcm.byteLength, 6, 'the header is still stripped');

    frame.writeDoubleLE(-1, 8);
    assert.equal(decodePcmFrame(frame).firstSampleIndex, null);
  });

  test('handles a header with no payload', () => {
    const decoded = decodePcmFrame(encodePcmFrame(3, 99, Buffer.alloc(0)));
    assert.equal(decoded.firstSampleIndex, 99);
    assert.equal(decoded.pcm.byteLength, 0);
  });
});
