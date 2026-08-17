import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { AudioPacketReceiver } from '../src/audio-packet-receiver.js';

function pcm(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt16LE(value, 0);
  buffer.writeInt16LE(value, 2);
  return buffer;
}

function packet(generation: number, sequence: number, firstSampleIndex: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation,
    sequence,
    firstSampleIndex,
    pcm: pcm(sequence),
  });
}

function receiver(generation: number) {
  return new AudioPacketReceiver({
    source: 'mic',
    generation,
    initialSequence: 0,
    reorderWindowPackets: 4,
    reorderDeadlineMs: 20,
    maxForwardJumpPackets: 32,
  });
}

test('malformed replacement traffic cannot erase same-capture continuity before the first valid packet', () => {
  const generation = 0x7f01;
  const first = receiver(generation);
  assert.deepEqual(first.receive(packet(generation, 0, 0), 1_000).map((item) => item.sequence), [0]);
  assert.deepEqual(first.receive(packet(generation, 1, 2), 1_001).map((item) => item.sequence), [1]);

  const replacement = receiver(generation);
  assert.deepEqual(replacement.receive(Buffer.from([1, 2, 3]), 1_010), []);
  assert.deepEqual(
    replacement.receive(packet(generation, 2, 4), 1_011).map((item) => item.sequence),
    [2],
    'a malformed first transport packet must not reset the capture receiver to sequence zero',
  );

  const stats = replacement.stats();
  assert.equal(stats.malformedPackets, 1);
  assert.equal(stats.lostPackets, 0);
  assert.equal(stats.replayPackets, 0);
});
