import assert from 'node:assert/strict';
import test from 'node:test';

import { sendPreflightCalibrationCommand } from '../public/calibration-command.js';

test('no-Song preflight authenticates before sending the calibration command', async () => {
  const previousWindow = (globalThis as any).window;
  const previousLocation = (globalThis as any).location;
  const previousWebSocket = (globalThis as any).WebSocket;

  type Listener = (event?: { data?: string }) => void;
  const sockets: FakeSocket[] = [];

  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    readyState = FakeSocket.CONNECTING;
    sent: string[] = [];
    listeners = new Map<string, Listener[]>();

    constructor(readonly url: string) {
      sockets.push(this);
    }

    addEventListener(type: string, listener: Listener) {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    emit(type: string, event: { data?: string } = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    send(payload: string) {
      this.sent.push(payload);
    }

    close() {
      this.readyState = FakeSocket.CLOSED;
    }
  }

  (globalThis as any).window = {
    relayParticipantId: 'participant-a',
    relayParticipantCapability: 'capability-a',
    relayNickname: 'Alice',
  };
  (globalThis as any).location = {
    protocol: 'https:',
    host: 'relay.test',
    search: '?key=room-key',
  };
  (globalThis as any).WebSocket = FakeSocket;

  try {
    const command = sendPreflightCalibrationCommand({ timeoutMs: 1_000 });
    assert.equal(sockets.length, 1);
    const socket = sockets[0]!;
    assert.equal(socket.url, 'wss://relay.test/ws?key=room-key');

    socket.readyState = FakeSocket.OPEN;
    socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'participant-authenticate',
      participantId: 'participant-a',
      capability: 'capability-a',
      nickname: 'Alice',
    });
    assert.equal(socket.sent.length, 1, 'calibration must wait for authentication acknowledgement');

    socket.emit('message', {
      data: JSON.stringify({ type: 'participant-authenticated', participantId: 'participant-a' }),
    });

    await command;
    assert.deepEqual(JSON.parse(socket.sent[1]!), { type: 'start-timing-calibration' });
    assert.equal(socket.readyState, FakeSocket.CLOSED);
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
    if (previousLocation === undefined) delete (globalThis as any).location;
    else (globalThis as any).location = previousLocation;
    if (previousWebSocket === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = previousWebSocket;
  }
});
