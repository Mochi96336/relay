import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS,
  DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS,
  PublisherCommandLiveness,
} from '../public/publisher-command-liveness.js';

test('publisher command channel stays stale until a correlated current-generation ACK', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(7, 1_000);
  assert.deepEqual(liveness.status(1_000), { fresh: false, reconnect: false, ackAgeMs: null });
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('current-generation ACK freshness is measured from the request send time', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(11, 500);
  const requestId = liveness.beginHealthRequest(1_000);
  assert.notEqual(requestId, null);
  assert.equal(liveness.noteAck(11, requestId!, 1_200), true);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS - 1).fresh, true);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS).fresh, false);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('a delayed health ACK cannot renew command freshness from its arrival time', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(17, 0);
  const requestId = liveness.beginHealthRequest(0);
  assert.notEqual(requestId, null);

  // The health request left this capture at t=0, but a one-way downstream
  // backlog delays the matching ACK until t=3500. Arrival itself is not fresh
  // evidence: the command channel has not proven a recent round trip.
  assert.equal(liveness.noteAck(17, requestId!, 3_500), true);
  assert.equal(liveness.status(3_500).fresh, false);
  assert.equal(liveness.status(DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('failed health sends cannot later become command freshness evidence', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(19, 0);
  const requestId = liveness.beginHealthRequest(500);
  assert.notEqual(requestId, null);
  assert.equal(liveness.cancelHealthRequest(requestId!), true);
  assert.equal(liveness.noteAck(19, requestId!, 600), false);
  assert.equal(liveness.status(600).fresh, false);
});

test('a newer correlated ACK supersedes older pending freshness evidence', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(20, 0);
  const oldRequestId = liveness.beginHealthRequest(100);
  const newRequestId = liveness.beginHealthRequest(1_000);
  assert.notEqual(oldRequestId, null);
  assert.notEqual(newRequestId, null);

  assert.equal(liveness.noteAck(20, newRequestId!, 1_100), true);
  assert.equal(liveness.status(1_100).fresh, true);
  assert.equal(liveness.noteAck(20, oldRequestId!, 1_200), false,
    'an older delayed ACK must not survive after a newer request advanced the proven frontier');
  assert.equal(liveness.status(1_200).ackAgeMs, 200);
});

test('same-generation command epoch reset cannot reuse an old health request id', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(23, 0);
  const retiredRequestId = liveness.beginHealthRequest(100);
  assert.notEqual(retiredRequestId, null);

  // Semantic command-authority reset can happen while the same physical socket
  // and capture generation remain current. A delayed ACK from the retired epoch
  // must therefore be distinguishable from every request in the replacement epoch.
  liveness.begin(23, 200);
  const currentRequestId = liveness.beginHealthRequest(250);
  assert.notEqual(currentRequestId, null);
  assert.notEqual(currentRequestId, retiredRequestId,
    'request ids must remain monotonic across same-generation liveness epochs');
  assert.equal(liveness.noteAck(23, retiredRequestId!, 300), false,
    'a delayed ACK from the retired command epoch must stay retired');
  assert.equal(liveness.noteAck(23, currentRequestId!, 300), true);
  assert.equal(liveness.status(300).fresh, true);
});

test('wrong-generation ACK cannot revive a replacement capture', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(21, 1_000);
  const requestId = liveness.beginHealthRequest(1_050);
  assert.notEqual(requestId, null);
  assert.equal(liveness.noteAck(20, requestId!, 1_100), false);
  assert.equal(liveness.status(1_100).fresh, false);
  assert.equal(liveness.noteAck(21, requestId!, 1_200), true);
  assert.equal(liveness.status(1_200).fresh, true);

  liveness.begin(22, 1_300);
  assert.equal(liveness.noteAck(21, requestId!, 1_400), false);
  assert.equal(liveness.status(1_400).fresh, false);
});

test('reset revokes command freshness and pending correlation without creating a reconnect', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(3, 100);
  const requestId = liveness.beginHealthRequest(150);
  assert.notEqual(requestId, null);
  assert.equal(liveness.noteAck(3, requestId!, 175), true);
  const pendingRequestId = liveness.beginHealthRequest(200);
  assert.notEqual(pendingRequestId, null);
  liveness.reset();
  assert.equal(liveness.noteAck(3, pendingRequestId!, 250), false);
  assert.deepEqual(liveness.status(100_000), { fresh: false, reconnect: false, ackAgeMs: null });
});
