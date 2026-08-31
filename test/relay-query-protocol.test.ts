import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayQueryProtocol } from '../src/relay-query-protocol.js';

type FakeSocket = { id: string };

function setup() {
  const sent: { socket: FakeSocket; payload: unknown }[] = [];
  const calls: string[] = [];
  const payload = (name: string) => () => {
    calls.push(name);
    return { type: `${name}-payload` };
  };
  const clock = [1_000, 1_001];
  const protocol = createRelayQueryProtocol<FakeSocket>({
    sendJson: (socket, body) => sent.push({ socket, payload: body }),
    sessionStatusPayload: payload('session'),
    productStatusPayload: payload('product'),
    takeStatusPayload: payload('take'),
    roomSongStatusPayload: payload('room-song'),
    roomSongCommandStatusPayload: payload('room-song-command'),
    youtubeTimelineStatusPayload: payload('youtube-timeline'),
    sourceStatusPayload: payload('source'),
    timingCalibrationStatusPayload: payload('timing-calibration'),
    wallClockMs: () => clock.shift() ?? 1_002,
  });
  return { protocol, sent, calls };
}

test('query protocol routes each read-only request to its existing payload owner', () => {
  const socket = { id: 'socket-a' };
  const { protocol, sent, calls } = setup();
  const cases = [
    ['session-status-request', 'session'],
    ['product-status-request', 'product'],
    ['take-status-request', 'take'],
    ['room-song-status-request', 'room-song'],
    ['room-song-command-status-request', 'room-song-command'],
    ['youtube-timeline-request', 'youtube-timeline'],
    ['source-status-request', 'source'],
    ['timing-calibration-status-request', 'timing-calibration'],
  ] as const;

  for (const [type] of cases) assert.equal(protocol.dispatch(socket, { type }), true);
  assert.deepEqual(calls, cases.map(([, owner]) => owner));
  assert.deepEqual(
    sent.map(({ payload: body }) => body),
    cases.map(([, owner]) => ({ type: `${owner}-payload` })),
  );
  assert.ok(sent.every(({ socket: destination }) => destination === socket));
});

test('clock ping remains a transport reply with both server timestamps', () => {
  const socket = { id: 'clock' };
  const { protocol, sent, calls } = setup();
  assert.equal(protocol.dispatch(socket, {
    type: 'clock-ping',
    id: 'ping-7',
    clientSentAtMs: 900,
  }), true);
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, [{
    socket,
    payload: {
      type: 'clock-pong',
      id: 'ping-7',
      clientSentAtMs: 900,
      serverReceivedAtMs: 1_000,
      serverSentAtMs: 1_001,
    },
  }]);
});

test('query protocol leaves commands and malformed envelopes to later routing', () => {
  const socket = { id: 'socket-b' };
  const { protocol, sent, calls } = setup();
  assert.equal(protocol.dispatch(socket, { type: 'start-take' }), false);
  assert.equal(protocol.dispatch(socket, { type: 42 }), false);
  assert.equal(protocol.dispatch(socket, {}), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(calls, []);
});
