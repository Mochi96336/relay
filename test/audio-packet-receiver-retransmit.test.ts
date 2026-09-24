import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { AudioPacketReceiver } from '../src/audio-packet-receiver.js';

// Continuity snapshots are keyed by source + generation across receivers, so
// every test here owns a distinct generation.
let nextGeneration = 90_001;

function packet(generation: number, sequence: number) {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(sequence & 0x7fff, 0);
  return encodeAudioPacket({
    source: 'mic',
    generation,
    sequence,
    firstSampleIndex: sequence * 2,
    pcm,
  });
}

function receiver(overrides: Partial<ConstructorParameters<typeof AudioPacketReceiver>[0]> = {}) {
  const generation = nextGeneration++;
  const r = new AudioPacketReceiver({
    source: 'mic',
    generation,
    initialSequence: 0,
    reorderWindowPackets: 4,
    reorderDeadlineMs: 40,
    maxForwardJumpPackets: 64,
    retransmitHoldMs: 200,
    retransmitWindowPackets: 32,
    retransmitRequestDelayMs: 0,
    ...overrides,
  });
  return { r, send: (sequence: number, nowMs: number) => r.receive(packet(generation, sequence), nowMs) };
}

const sequences = (packets: { sequence: number }[]) => packets.map((p) => p.sequence);

describe('AudioPacketReceiver retransmission', () => {
  it('asks once for each sequence a later packet proves missing', () => {
    const { r, send } = receiver();
    send(0, 0);
    send(3, 1);
    assert.deepEqual(r.takeRetransmitRequests(), [1, 2]);
    send(4, 2);
    assert.deepEqual(r.takeRetransmitRequests(), [], 'an already-requested hole is not asked again');
    assert.equal(r.retransmitStats().requestedPackets, 2);
  });

  it('holds the ordered stream for a requested repeat while the mix can afford it', () => {
    const { r, send } = receiver();
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    r.takeRetransmitRequests();

    // Well past the 40 ms reorder deadline, but inside the 200 ms hold.
    assert.deepEqual(sequences(r.flush(120)), []);
    for (let sequence = 3; sequence < 12; sequence += 1) send(sequence, 120);
    assert.equal(r.stats().lostPackets, 0, 'the wider hold window keeps waiting');

    assert.deepEqual(sequences(send(1, 130)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(r.stats().lostPackets, 0);
    assert.deepEqual(r.retransmitStats(), { requestedPackets: 1, recoveredPackets: 1, budgetDeniedPackets: 0 });
  });

  it('gives a requested repeat up at the hold deadline', () => {
    const { r, send } = receiver();
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    assert.deepEqual(sequences(r.flush(200)), []);
    assert.deepEqual(sequences(r.flush(201)), [2]);
    assert.equal(r.stats().lostPackets, 1);
    assert.deepEqual(sequences(send(1, 210)), [], 'a repeat after the deadline is late, not re-inserted');
    assert.equal(r.stats().latePackets, 1);
  });

  it('releases a waiting hole at the ordinary deadline once the mix withdraws the hold', () => {
    const { r, send } = receiver();
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    assert.deepEqual(sequences(r.flush(60)), []);
    r.setRetransmitHoldAllowed(false);
    assert.deepEqual(sequences(r.flush(61)), [2], 'low headroom beats waiting for a repeat');
    assert.equal(r.stats().lostPackets, 1);
  });

  it('keeps the ordinary reorder behaviour when retransmission is disabled', () => {
    const { r, send } = receiver({ retransmitHoldMs: 0 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    assert.deepEqual(r.takeRetransmitRequests(), []);
    assert.deepEqual(sequences(r.flush(41)), [2]);
  });

  it('stops asking once sustained loss spends the request budget, and never holds for it', () => {
    const { r, send } = receiver({ retransmitRequestsPerSecond: 2 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    send(4, 2);
    assert.deepEqual(r.takeRetransmitRequests(), [1, 3], 'the initial budget covers isolated loss');

    send(6, 3);
    assert.deepEqual(r.takeRetransmitRequests(), [], 'a third loss inside the same second is not requested');
    assert.equal(r.retransmitStats().budgetDeniedPackets, 1);

    // The budget refills with time. A denied hole that is still missing is
    // reconsidered first; what the refill cannot cover stays denied.
    send(8, 600);
    assert.deepEqual(r.takeRetransmitRequests(), [5]);
    assert.equal(r.retransmitStats().budgetDeniedPackets, 2);
  });

  it('refunds request budget when a promoted repeat was never sent', () => {
    const { r, send } = receiver({ retransmitRequestsPerSecond: 1 });
    send(0, 0);
    send(2, 1);
    assert.deepEqual(r.takeRetransmitRequests(), [1]);
    assert.equal(r.retransmitStats().requestedPackets, 1);

    assert.equal(r.cancelRetransmitRequests([1]), 1);
    assert.equal(r.retransmitStats().requestedPackets, 0);

    // No time has passed to refill the 1/s bucket. Packet 3 merely re-proves
    // the same still-missing sequence 1 while 2 is already pending. The request
    // is possible only if cancellation returned the token that never left Relay.
    send(3, 2);
    assert.deepEqual(
      r.takeRetransmitRequests(),
      [1],
      'an unsent request must not consume the next real recovery opportunity',
    );
    assert.deepEqual(r.retransmitStats(), {
      requestedPackets: 1,
      recoveredPackets: 0,
      budgetDeniedPackets: 0,
    });
  });

  it('records no requests for a sender that cannot answer them', () => {
    const { r, send } = receiver();
    r.setRetransmitRequestsEnabled(false);
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    assert.deepEqual(r.takeRetransmitRequests(), []);
    assert.equal(r.retransmitStats().requestedPackets, 0);
    assert.deepEqual(sequences(r.flush(41)), [2], 'and never holds for a repeat that cannot come');
  });

  it('waits for the request delay so merely reordered datagrams are never requested', () => {
    const { r, send } = receiver({ retransmitRequestDelayMs: 20 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    send(4, 2);
    assert.deepEqual(r.takeRetransmitRequests(), [], 'nothing is requested the moment a gap appears');

    // 1 was only reordered and arrives inside the delay; 3 really was lost.
    send(1, 10);
    assert.deepEqual(sequences(r.flush(22)), []);
    assert.deepEqual(r.takeRetransmitRequests(), [3]);
    assert.equal(r.retransmitStats().requestedPackets, 1);

    // The hole was held from the moment it was noticed, not only once requested.
    assert.equal(r.stats().lostPackets, 0);
    assert.deepEqual(sequences(send(3, 90)), [3, 4]);
    assert.deepEqual(r.retransmitStats(), { requestedPackets: 1, recoveredPackets: 1, budgetDeniedPackets: 0 });
  });

  it('bounds requests for one enormous hole to the most recent sequences', () => {
    const { r, send } = receiver({ retransmitRequestsPerSecond: 100 });
    send(0, 0);
    send(60, 1);
    const requests = r.takeRetransmitRequests();
    assert.equal(requests.length, 32);
    assert.equal(requests[0], 28);
    assert.equal(requests.at(-1), 59);
  });
});
