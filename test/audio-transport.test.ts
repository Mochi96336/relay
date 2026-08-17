import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { createWebSocketAudioTransport } from '../src/audio-transport.js';
import { encodePcmFrame } from '../src/pcm-frame.js';

function pcm(...samples: number[]) {
  const output = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
  return output;
}

describe('AudioTransport server boundary', () => {
  it('keeps legacy WebSocket PCM behavior behind the transport adapter', () => {
    const transport = createWebSocketAudioTransport({ packetVersion: 1 });
    const payload = pcm(10, 20, 30);
    const [frame] = transport.receive(encodePcmFrame(7, 100, payload), 0);

    assert.equal(transport.kind, 'websocket');
    assert.equal(transport.packetVersion, 1);
    assert.equal(frame.generation, 7);
    assert.equal(frame.firstSampleIndex, 100);
    assert.deepEqual(frame.pcm, payload);
    assert.deepEqual(transport.flush(100), []);
    assert.equal(transport.stats(), null);
  });

  it('keeps v2 reorder semantics inside the transport adapter', () => {
    const transport = createWebSocketAudioTransport({
      packetVersion: 2,
      receiver: {
        source: 'mic',
        generation: 9,
        reorderWindowPackets: 4,
        reorderDeadlineMs: 40,
        maxForwardJumpPackets: 16,
      },
    });

    // Establish an explicit fresh-capture origin before testing reordering.
    // Receiver continuity is intentionally shared across short reconnects, so
    // a test that reuses a generation must not inherit another test's snapshot.
    const origin = encodeAudioPacket({
      source: 'mic',
      generation: 9,
      sequence: 0,
      firstSampleIndex: 0,
      pcm: pcm(10, 20),
    });
    const second = encodeAudioPacket({
      source: 'mic',
      generation: 9,
      sequence: 2,
      firstSampleIndex: 4,
      pcm: pcm(50, 60),
    });
    const first = encodeAudioPacket({
      source: 'mic',
      generation: 9,
      sequence: 1,
      firstSampleIndex: 2,
      pcm: pcm(30, 40),
    });

    assert.deepEqual(transport.receive(origin, 0).map((frame) => frame.firstSampleIndex), [0]);
    assert.deepEqual(transport.receive(second, 1), []);
    const emitted = transport.receive(first, 2);
    assert.deepEqual(emitted.map((frame) => frame.firstSampleIndex), [2, 4]);
    assert.equal(transport.stats()?.reorderedPackets, 1);
  });
});
