import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const moduleUrl = new URL('../public/audio-packetizer.js', import.meta.url);
type Segment = { pcm: ArrayBuffer; sampleOffset: number };

describe('browser AudioPacket packetizer', () => {
  it('keeps one PCM chunk intact when the physical transport has no packet limit', async () => {
    const { splitPcmForPacketLimit } = await import(moduleUrl.href);
    const pcm = new ArrayBuffer(1920);
    const segments = splitPcmForPacketLimit(pcm, Number.POSITIVE_INFINITY, 24) as Segment[];

    assert.equal(segments.length, 1);
    assert.equal(segments[0].pcm, pcm);
    assert.equal(segments[0].sampleOffset, 0);
  });

  it('splits a 20 ms / 48 kHz chunk into complete AudioPackets that fit a 1200-byte datagram budget', async () => {
    const { splitPcmForPacketLimit } = await import(moduleUrl.href);
    const pcm = new ArrayBuffer(1920); // 960 mono Int16 samples
    const segments = splitPcmForPacketLimit(pcm, 1200, 24) as Segment[];

    assert.deepEqual(
      segments.map((segment) => ({
        sampleOffset: segment.sampleOffset,
        pcmBytes: segment.pcm.byteLength,
        packetBytes: 24 + segment.pcm.byteLength,
      })),
      [
        { sampleOffset: 0, pcmBytes: 1176, packetBytes: 1200 },
        { sampleOffset: 588, pcmBytes: 744, packetBytes: 768 },
      ],
    );
  });

  it('always cuts on Int16 sample boundaries even for an odd byte budget', async () => {
    const { splitPcmForPacketLimit } = await import(moduleUrl.href);
    const segments = splitPcmForPacketLimit(new ArrayBuffer(20), 31, 24) as Segment[];

    assert.deepEqual(segments.map((segment) => segment.pcm.byteLength), [6, 6, 6, 2]);
    assert.deepEqual(segments.map((segment) => segment.sampleOffset), [0, 3, 6, 9]);
  });

  it('rejects a datagram budget that cannot hold the header plus one Int16 sample', async () => {
    const { splitPcmForPacketLimit } = await import(moduleUrl.href);
    assert.throws(() => splitPcmForPacketLimit(new ArrayBuffer(2), 25, 24), /Int16 sample/);
  });
});
