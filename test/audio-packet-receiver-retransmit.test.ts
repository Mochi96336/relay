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
  it('holds for a late packet only while the caller allows, requested or not', () => {
    const { r, send } = receiver({ retransmitRequestsPerSecond: 1 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    send(4, 2);
    // 1 was requested with the only token; 3 was denied, yet still waits.
    assert.deepEqual(r.takeRetransmitRequests(2), [1]);
    assert.equal(r.retransmitStats().budgetDeniedPackets, 1);
    assert.deepEqual(sequences(send(1, 100)), [1, 2]);
    assert.deepEqual(sequences(r.flush(150)), [], 'the denied hole still holds');
    assert.deepEqual(sequences(send(3, 160)), [3, 4], 'and its late packet is heard');
    assert.equal(r.stats().lostPackets, 0);

    send(6, 170);
    r.setRetransmitHoldAllowed(false);
    assert.deepEqual(sequences(r.flush(211)), [6], 'without headroom the hole is released at the reorder deadline');
    assert.equal(r.stats().lostPackets, 1);
  });

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
    r.takeRetransmitRequests(1);

    // Well past the 40 ms reorder deadline, but inside the 200 ms hold.
    assert.deepEqual(sequences(r.flush(120)), []);
    for (let sequence = 3; sequence < 12; sequence += 1) send(sequence, 120);
    assert.equal(r.stats().lostPackets, 0, 'the wider hold window keeps waiting');

    assert.deepEqual(sequences(send(1, 130)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(r.stats().lostPackets, 0);
    assert.deepEqual(r.retransmitStats(), {
      requestedPackets: 1,
      recoveredPackets: 1,
      budgetDeniedPackets: 0,
      retriedPackets: 0,
      repairRoundTripMs: 129,
    });
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
    // A hold long enough that nothing is given up while the budget refills.
    const { r, send } = receiver({ retransmitRequestsPerSecond: 2, retransmitHoldMs: 1_000 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    send(4, 2);
    assert.deepEqual(r.takeRetransmitRequests(2), [1, 3], 'the initial budget covers isolated loss');

    send(6, 3);
    assert.deepEqual(r.takeRetransmitRequests(3), [], 'a third loss inside the same second is not requested');
    assert.equal(r.retransmitStats().budgetDeniedPackets, 1);

    // The budget refills with time. A denied hole that is still missing is
    // reconsidered first; what the refill cannot cover stays denied.
    send(8, 600);
    assert.deepEqual(r.takeRetransmitRequests(600), [5]);
    assert.equal(r.retransmitStats().budgetDeniedPackets, 2);
  });

  it('records no requests for a sender that cannot answer them', () => {
    const { r, send } = receiver();
    r.setRetransmitRequestsEnabled(false);
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    assert.deepEqual(r.takeRetransmitRequests(), []);
    assert.equal(r.retransmitStats().requestedPackets, 0);
    // It may still be merely late: the stream waits while the caller allows.
    assert.deepEqual(sequences(r.flush(41)), []);
    assert.deepEqual(sequences(send(1, 90)), [1, 2], 'a late packet is heard, not lost');
    assert.equal(r.stats().lostPackets, 0);
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
    assert.deepEqual(r.takeRetransmitRequests(22), [3]);
    assert.equal(r.retransmitStats().requestedPackets, 1);

    // The hole was held from the moment it was noticed, not only once requested.
    assert.equal(r.stats().lostPackets, 0);
    assert.deepEqual(sequences(send(3, 90)), [3, 4]);
    assert.deepEqual(r.retransmitStats(), {
      requestedPackets: 1,
      recoveredPackets: 1,
      budgetDeniedPackets: 0,
      retriedPackets: 0,
      repairRoundTripMs: 68,
    });
  });

  it('bounds requests for one enormous hole to the most recent sequences', () => {
    const { r, send } = receiver({ retransmitRequestsPerSecond: 100 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(60, 1);
    const requests = r.takeRetransmitRequests();
    assert.equal(requests.length, 32);
    assert.equal(requests[0], 28);
    assert.equal(requests.at(-1), 59);
  });

  it('never asks for a sequence it has already given up on', () => {
    const { r, send } = receiver({ retransmitRequestsPerSecond: 100 });
    send(0, 0);
    // Without a hold the ordinary 4-packet window abandons most of the hole
    // inside the same receive that noticed it.
    send(60, 1);
    assert.deepEqual(r.takeRetransmitRequests(1), [56, 57, 58, 59]);
  });

  it('keeps a request queued until it has actually been sent', () => {
    const { r, send } = receiver();
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    const pending = r.pendingRetransmitRequests();
    assert.deepEqual(pending, [{ sequence: 1, attempt: 0 }]);
    // No path this tick: the caller sends nothing and confirms nothing.
    assert.deepEqual(r.pendingRetransmitRequests(), pending, 'reading does not consume');
    assert.equal(r.retransmitStats().requestedPackets, 0, 'nothing has left Relay yet');

    r.retransmitRequestsSent(pending, 30);
    assert.deepEqual(r.pendingRetransmitRequests(), []);
    assert.equal(r.retransmitStats().requestedPackets, 1);
    // Confirming the same request twice does not count it twice.
    r.retransmitRequestsSent(pending, 31);
    assert.equal(r.retransmitStats().requestedPackets, 1);
  });

  it('does not count a hole as recovered when no request ever left', () => {
    const { r, send } = receiver();
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    assert.equal(r.pendingRetransmitRequests().length, 1);
    assert.deepEqual(sequences(send(1, 5)), [1, 2]);
    assert.equal(r.retransmitStats().recoveredPackets, 0);
  });

  it('asks once more when the repeat itself is lost, then stops', () => {
    const { r, send } = receiver({ retransmitHoldMs: 1_000 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    r.retransmitRequestsSent(r.pendingRetransmitRequests(), 1);

    // Before any round trip is known, the retry waits 150 ms.
    r.flush(150);
    assert.deepEqual(r.pendingRetransmitRequests(), []);
    r.flush(151);
    assert.deepEqual(r.pendingRetransmitRequests(), [{ sequence: 1, attempt: 1 }]);
    r.retransmitRequestsSent(r.pendingRetransmitRequests(), 151);
    assert.equal(r.retransmitStats().retriedPackets, 1);
    assert.equal(r.retransmitStats().requestedPackets, 1, 'a retry is not a new sequence');

    r.flush(900);
    assert.deepEqual(r.pendingRetransmitRequests(), [], 'two attempts is the limit');

    assert.deepEqual(sequences(send(1, 910)), [1, 2]);
    assert.equal(r.retransmitStats().recoveredPackets, 1);
    assert.equal(r.retransmitStats().repairRoundTripMs, null, 'a retried arrival is ambiguous and never timed');
  });

  it('paces retries from the measured repair round trip', () => {
    const { r, send } = receiver({ retransmitHoldMs: 1_000 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    send(2, 1);
    r.retransmitRequestsSent(r.pendingRetransmitRequests(), 10);
    send(1, 50);
    assert.equal(r.retransmitStats().repairRoundTripMs, 40);

    send(4, 100);
    r.retransmitRequestsSent(r.pendingRetransmitRequests(), 100);
    // The 40 ms round trip plus four times its variation (half the first
    // sample): 120 ms, as TCP sizes its retransmission timeout.
    r.flush(219);
    assert.deepEqual(r.pendingRetransmitRequests(), []);
    r.flush(220);
    assert.deepEqual(r.pendingRetransmitRequests(), [{ sequence: 3, attempt: 1 }]);
  });

  it('retries only from spare budget, keeping a reserve for fresh holes', () => {
    // 5 requests/s: a fifth of it (one token) is kept back from retries.
    const { r, send } = receiver({ retransmitHoldMs: 2_000, retransmitRequestsPerSecond: 5 });
    r.setRetransmitHoldAllowed(true);
    send(0, 0);
    for (const sequence of [2, 4, 6, 8]) send(sequence, sequence / 2);
    const first = r.pendingRetransmitRequests();
    assert.deepEqual(first.map(({ sequence }) => sequence), [1, 3, 5, 7]);
    r.retransmitRequestsSent(first, 5);

    // One token left, plus refill: not enough above the reserve to retry.
    r.flush(160);
    assert.deepEqual(r.pendingRetransmitRequests(), []);
    // Refill lifts the budget above the reserve for exactly one retry.
    r.flush(260);
    assert.deepEqual(r.pendingRetransmitRequests(), [{ sequence: 1, attempt: 1 }]);
    assert.equal(r.retransmitStats().retriedPackets, 1);
  });
});
