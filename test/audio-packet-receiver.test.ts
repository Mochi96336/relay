import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { AudioPacketReceiver } from '../src/audio-packet-receiver.js';

function pcm(...values: number[]) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
}

function packet(sequence: number, firstSampleIndex: number, options: {
  generation?: number;
  source?: 'mic' | 'backing';
  pcm?: Buffer;
} = {}) {
  return encodeAudioPacket({
    source: options.source ?? 'mic',
    generation: options.generation ?? 7,
    sequence,
    firstSampleIndex,
    pcm: options.pcm ?? pcm(sequence & 0x7fff, 1),
  });
}

function receiver(overrides: Partial<ConstructorParameters<typeof AudioPacketReceiver>[0]> = {}) {
  return new AudioPacketReceiver({
    source: 'mic',
    generation: 7,
    initialSequence: 0,
    reorderWindowPackets: 4,
    reorderDeadlineMs: 20,
    maxForwardJumpPackets: 32,
    ...overrides,
  });
}

describe('AudioPacketReceiver', () => {
  test('reorders packets inside the window without inventing a gap', () => {
    const r = receiver({ initialSequence: 100 });
    assert.deepEqual(r.receive(packet(100, 0), 0).map((p) => p.sequence), [100]);
    assert.deepEqual(r.receive(packet(102, 4), 1).map((p) => p.sequence), []);
    assert.deepEqual(r.receive(packet(101, 2), 2).map((p) => p.sequence), [101, 102]);

    const stats = r.stats();
    assert.equal(stats.reorderedPackets, 1);
    assert.equal(stats.lostPackets, 0);
    assert.equal(stats.bufferedPackets, 0);
  });

  test('counts a lost packet even when it was lost before anything arrived', () => {
    const r = receiver({ reorderDeadlineMs: 10 });
    assert.deepEqual(r.receive(packet(1, 2), 0), []);
    assert.deepEqual(r.flush(9), []);
    assert.deepEqual(r.flush(10).map((p) => p.sequence), [1]);
    assert.equal(r.stats().lostPackets, 1, 'known capture sequence zero must not disappear from loss evidence');
  });

  test('declares a missing packet lost only after the deadline', () => {
    const r = receiver({ initialSequence: 10, reorderDeadlineMs: 10 });
    r.receive(packet(10, 0), 0);
    assert.deepEqual(r.receive(packet(12, 4), 1), []);
    assert.deepEqual(r.flush(9), []);
    assert.deepEqual(r.flush(11).map((p) => p.sequence), [12]);
    assert.equal(r.stats().lostPackets, 1);
  });

  test('window pressure advances only genuinely missing sequences', () => {
    const r = receiver({ initialSequence: 10, reorderWindowPackets: 2 });
    r.receive(packet(10, 0), 0);
    r.receive(packet(12, 4), 1);
    const output = r.receive(packet(14, 8), 2);

    assert.deepEqual(output.map((p) => p.sequence), [12]);
    assert.equal(r.stats().lostPackets, 1);
  });

  test('distinguishes duplicate, late and replayed packets', () => {
    const r = receiver({ initialSequence: 20, reorderDeadlineMs: 5 });
    r.receive(packet(20, 0), 0);
    r.receive(packet(22, 4), 1);
    r.receive(packet(22, 4), 2);
    assert.equal(r.stats().duplicatePackets, 1, 'duplicate while buffered');

    r.flush(10);
    r.receive(packet(20, 0), 11);
    assert.equal(r.stats().duplicatePackets, 2, 'duplicate after emission');

    r.receive(packet(21, 2), 12);
    assert.equal(r.stats().latePackets, 1, 'packet that arrives after being declared lost');

    r.receive(packet(19, 0), 13);
    assert.equal(r.stats().replayPackets, 1, 'old sequence outside known finalized history');
  });

  test('handles uint32 sequence wraparound', () => {
    const r = receiver({ initialSequence: 0xffff_fffe });
    assert.deepEqual(r.receive(packet(0xffff_fffe, 0), 0).map((p) => p.sequence), [0xffff_fffe]);
    assert.deepEqual(r.receive(packet(0xffff_ffff, 2), 1).map((p) => p.sequence), [0xffff_ffff]);
    assert.deepEqual(r.receive(packet(0, 4), 2).map((p) => p.sequence), [0]);
    assert.equal(r.stats().lostPackets, 0);
  });

  test('control-plane generation is authoritative', () => {
    const r = receiver({ initialSequence: 1 });
    assert.deepEqual(r.receive(packet(1, 0, { generation: 6 }), 0), []);
    assert.equal(r.stats().wrongGenerationPackets, 1);
    assert.deepEqual(r.receive(packet(1, 0, { generation: 7 }), 1).map((p) => p.sequence), [1]);
  });

  test('rejects packets from the wrong media source', () => {
    const r = receiver({ initialSequence: 1 });
    assert.deepEqual(r.receive(packet(1, 0, { source: 'backing' }), 0), []);
    assert.equal(r.stats().wrongSourcePackets, 1);
  });

  test('rejects wildly future sequence numbers without growing memory', () => {
    const r = receiver({ initialSequence: 10, maxForwardJumpPackets: 8, reorderWindowPackets: 4 });
    r.receive(packet(10, 0), 0);
    assert.deepEqual(r.receive(packet(100, 2), 1), []);
    assert.equal(r.stats().futurePackets, 1);
    assert.equal(r.stats().bufferedPackets, 0);
  });

  test('rejects a sample range that moves backward even when sequence is valid', () => {
    const r = receiver({ initialSequence: 1 });
    r.receive(packet(1, 10), 0);
    assert.deepEqual(r.receive(packet(2, 11), 1), []);
    assert.equal(r.stats().invalidSampleRangePackets, 1);

    assert.deepEqual(r.receive(packet(3, 14), 2).map((p) => p.sequence), [3]);
  });

  test('counts malformed packets without passing them downstream', () => {
    const r = receiver();
    assert.deepEqual(r.receive(Buffer.from([1, 2, 3]), 0), []);
    assert.equal(r.stats().malformedPackets, 1);
    assert.equal(r.stats().emittedPackets, 0);
  });

  test('sample-index gaps survive reorder as timeline evidence', () => {
    const r = receiver({ initialSequence: 1 });
    r.receive(packet(1, 0), 0);
    r.receive(packet(3, 20), 1);
    const output = r.receive(packet(2, 10), 2);
    assert.deepEqual(output.map((p) => [p.sequence, p.firstSampleIndex]), [[2, 10], [3, 20]]);
    assert.equal(r.stats().lostPackets, 0, 'capture gaps are not transport packet loss');
  });

  test('same capture receiver replacement resumes the sequence and timeline frontier', () => {
    const generation = 113;
    const first = receiver({ generation });
    assert.deepEqual(first.receive(packet(0, 0, { generation }), 1_000).map((p) => p.sequence), [0]);
    assert.deepEqual(first.receive(packet(1, 2, { generation }), 1_001).map((p) => p.sequence), [1]);

    const replacement = receiver({ generation });
    assert.deepEqual(
      replacement.receive(packet(2, 4, { generation }), 1_010).map((p) => p.sequence),
      [2],
      'transport replacement must not restart the receiver at sequence zero',
    );
    assert.equal(replacement.stats().lostPackets, 0);
    assert.equal(replacement.stats().replayPackets, 0);
  });

  test('fresh sequence zero resets a coincidentally reused generation instead of inheriting history', () => {
    const generation = 114;
    const first = receiver({ generation });
    first.receive(packet(0, 0, { generation }), 2_000);
    first.receive(packet(1, 2, { generation }), 2_001);

    const fresh = receiver({ generation });
    assert.deepEqual(fresh.receive(packet(0, 0, { generation }), 2_010).map((p) => p.sequence), [0]);
    assert.equal(fresh.stats().lostPackets, 0);
    assert.equal(fresh.stats().duplicatePackets, 0);
  });
});
