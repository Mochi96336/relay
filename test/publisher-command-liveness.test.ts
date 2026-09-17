import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS,
  DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS,
  PublisherCommandLiveness,
} from '../public/publisher-command-liveness.js';

test('publisher command channel stays stale until a current-generation ACK', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(7, 1_000);
  assert.deepEqual(liveness.status(1_000), { fresh: false, reconnect: false, ackAgeMs: null });
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('current-generation ACK expires before reconnect deadline', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(11, 500);
  assert.equal(liveness.noteAck(11, 1_000), true);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS - 1).fresh, true);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS).fresh, false);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('a delayed health ACK cannot renew command freshness from its arrival time', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(17, 0);

  // The health request left this capture at t=0, but a one-way downstream
  // backlog delays the matching ACK until t=3500. Arrival itself is not fresh
  // evidence: the command channel has not proven a recent round trip.
  assert.equal(liveness.noteAck(17, 3_500, 0), true);
  assert.equal(liveness.status(3_500).fresh, false);
  assert.equal(liveness.status(DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('wrong-generation ACK cannot revive a replacement capture', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(21, 1_000);
  assert.equal(liveness.noteAck(20, 1_100), false);
  assert.equal(liveness.status(1_100).fresh, false);
  assert.equal(liveness.noteAck(21, 1_200), true);
  assert.equal(liveness.status(1_200).fresh, true);
  liveness.begin(22, 1_300);
  assert.equal(liveness.noteAck(21, 1_400), false);
  assert.equal(liveness.status(1_400).fresh, false);
});

test('reset revokes command freshness without creating a reconnect', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(3, 100);
  liveness.noteAck(3, 150);
  liveness.reset();
  assert.deepEqual(liveness.status(100_000), { fresh: false, reconnect: false, ackAgeMs: null });
});
