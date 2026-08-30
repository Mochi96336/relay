import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PlaybackTransportRuntime } from '../src/playback-transport-runtime.js';

type TestSocket = {
  open: boolean;
  sent: unknown[];
  playbackParticipantId?: string;
  playbackTransportId?: string;
  playbackGeneration?: number;
  playbackMicIntentAtMs?: number;
};

function socket(open = true): TestSocket {
  return { open, sent: [] };
}

function runtime(clients: TestSocket[], micIntentMs = 10_000) {
  return new PlaybackTransportRuntime<TestSocket>({
    clients: () => clients,
    isOpen: (candidate) => candidate.open,
    send: (candidate, payload) => candidate.sent.push(payload),
    micIntentMs,
  });
}

const aliceOne = { participantId: 'participant-alice', transportId: 'tab-1', generation: 1 };
const aliceTwo = { participantId: 'participant-alice', transportId: 'tab-2', generation: 2 };
const bobOne = { participantId: 'participant-bob', transportId: 'tab-1', generation: 1 };

describe('PlaybackTransportRuntime', () => {
  test('validates the intent window', () => {
    assert.throws(() => runtime([], 0), /micIntentMs must be positive/);
  });

  test('owns playback identity metadata and leaves a socket unidentified until registration', () => {
    const client = socket();
    const transport = runtime([client]);
    assert.equal(transport.identity(client), null);
    assert.equal(transport.noteMicIntent(client, 100), false);
    assert.deepEqual(transport.register(client, aliceOne), aliceOne);
    assert.deepEqual(transport.identity(client), aliceOne);
    assert.equal(transport.noteMicIntent(client, 120), true);
    assert.equal(client.playbackMicIntentAtMs, 120);
  });

  test('routes only to open sockets with the exact participant, transport and generation', () => {
    const exact = socket();
    const staleGeneration = socket();
    const closed = socket(false);
    const other = socket();
    const transport = runtime([exact, staleGeneration, closed, other]);
    transport.register(exact, aliceOne);
    transport.register(staleGeneration, { ...aliceOne, generation: 0 });
    transport.register(closed, aliceOne);
    transport.register(other, bobOne);

    const payload = { type: 'apply' };
    assert.equal(transport.send(aliceOne, payload), 1);
    assert.deepEqual(exact.sent, [payload]);
    assert.deepEqual(staleGeneration.sent, []);
    assert.deepEqual(closed.sent, []);
    assert.deepEqual(other.sent, []);
    assert.equal(transport.connected(aliceOne), true);
    exact.open = false;
    assert.equal(transport.connected(aliceOne), false);
  });

  test('selects the newest recent Mic intent and refuses to guess between stale tabs', () => {
    const first = socket();
    const second = socket();
    const other = socket();
    const transport = runtime([first, second, other], 1_000);
    transport.register(first, aliceOne);
    transport.register(second, aliceTwo);
    transport.register(other, bobOne);
    transport.noteMicIntent(first, 1_100);
    transport.noteMicIntent(second, 1_500);

    assert.deepEqual(transport.selectHandoffTarget('participant-alice', 2_000), aliceTwo);
    assert.equal(transport.selectHandoffTarget('participant-alice', 3_000), null);
  });

  test('falls back only when one open playback transport exists for the participant', () => {
    const first = socket();
    const closed = socket(false);
    const transport = runtime([first, closed], 1_000);
    transport.register(first, aliceOne);
    transport.register(closed, aliceTwo);
    assert.deepEqual(transport.selectHandoffTarget('participant-alice', 50_000), aliceOne);

    closed.open = true;
    assert.equal(transport.selectHandoffTarget('participant-alice', 50_000), null);
  });

  test('preserves an existing Mic intent when the same socket registers a new generation', () => {
    const client = socket();
    const transport = runtime([client]);
    transport.register(client, aliceOne);
    transport.noteMicIntent(client, 500);
    transport.register(client, { ...aliceOne, generation: 2 });
    assert.equal(client.playbackMicIntentAtMs, 500);
  });
});
