import assert from 'node:assert/strict';
import test from 'node:test';

import { PublisherHealthRequestCorrelation } from '../public/publisher-health-correlation.js';

test('publisher health correlation returns the send time only to the owning socket/capture', () => {
  const correlation = new PublisherHealthRequestCorrelation();
  const socket = {};
  const requestId = correlation.issue({
    socket,
    sessionEpoch: 5,
    generation: 17,
    sentAtMs: 1_000,
  });

  assert.equal(correlation.consume({
    requestId,
    socket,
    sessionEpoch: 5,
    generation: 17,
  }), 1_000);
  assert.equal(correlation.consume({ requestId, socket, sessionEpoch: 5, generation: 17 }), null);
});

test('wrong socket, session, or generation consumes stale correlation without granting authority', () => {
  const correlation = new PublisherHealthRequestCorrelation();
  const socket = {};

  const wrongSocket = correlation.issue({ socket, sessionEpoch: 5, generation: 17, sentAtMs: 1_000 });
  assert.equal(correlation.consume({
    requestId: wrongSocket,
    socket: {},
    sessionEpoch: 5,
    generation: 17,
  }), null);

  const wrongSession = correlation.issue({ socket, sessionEpoch: 5, generation: 17, sentAtMs: 1_100 });
  assert.equal(correlation.consume({
    requestId: wrongSession,
    socket,
    sessionEpoch: 6,
    generation: 17,
  }), null);

  const wrongGeneration = correlation.issue({ socket, sessionEpoch: 5, generation: 17, sentAtMs: 1_200 });
  assert.equal(correlation.consume({
    requestId: wrongGeneration,
    socket,
    sessionEpoch: 5,
    generation: 18,
  }), null);
});

test('pending health correlation is bounded and explicit send failure can forget an issued request', () => {
  const correlation = new PublisherHealthRequestCorrelation({ maxPending: 2 });
  const socket = {};
  const first = correlation.issue({ socket, sessionEpoch: 1, generation: 7, sentAtMs: 0 });
  const second = correlation.issue({ socket, sessionEpoch: 1, generation: 7, sentAtMs: 1 });
  const third = correlation.issue({ socket, sessionEpoch: 1, generation: 7, sentAtMs: 2 });

  assert.equal(correlation.consume({ requestId: first, socket, sessionEpoch: 1, generation: 7 }), null);
  assert.equal(correlation.forget(second), true);
  assert.equal(correlation.consume({ requestId: second, socket, sessionEpoch: 1, generation: 7 }), null);
  assert.equal(correlation.consume({ requestId: third, socket, sessionEpoch: 1, generation: 7 }), 2);
});
