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

  assert.equal(liveness.noteAck(17, 3_500, 0), true);
  assert.equal(liveness.status(3_500).fresh, false);
  assert.equal(liveness.status(DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('older correlated ACKs cannot move the command freshness frontier backward', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(19, 0);
  assert.equal(liveness.noteAck(19, 2_000, 1_500), true);
  assert.equal(liveness.noteAck(19, 2_100, 500), true);
  assert.deepEqual(liveness.status(2_100), { fresh: true, reconnect: false, ackAgeMs: 600 });
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
