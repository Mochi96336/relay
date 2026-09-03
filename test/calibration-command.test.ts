import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = `${readFileSync(new URL('../public/calibration-command.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace('export function sendPreflightCalibrationCommand', 'function sendPreflightCalibrationCommand')}\n`
  + 'globalThis.sendPreflightCalibrationCommand = sendPreflightCalibrationCommand;\n';

type Listener = (event?: { data?: string }) => void;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  listeners = new Map<string, Listener[]>();

  constructor(readonly url: string, private readonly sockets: FakeSocket[]) {
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

function harness() {
  const sockets: FakeSocket[] = [];
  const WebSocketCtor = class extends FakeSocket {
    static readonly CONNECTING = FakeSocket.CONNECTING;
    static readonly OPEN = FakeSocket.OPEN;
    static readonly CLOSED = FakeSocket.CLOSED;

    constructor(url: string) {
      super(url, sockets);
    }
  };

  const context: Record<string, any> = {
    WebSocket: WebSocketCtor,
    location: {
      protocol: 'https:',
      host: 'relay.test',
      search: '?key=room-key',
    },
    URLSearchParams,
    JSON,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
    sendParticipantAuthentication(socket: FakeSocket) {
      socket.send(JSON.stringify({
        type: 'participant-authenticate',
        participantId: 'participant-a',
        capability: 'capability-a',
        nickname: 'Alice',
      }));
      return true;
    },
  };
  runInNewContext(source, context);

  return {
    sockets,
    sendPreflightCalibrationCommand: context.sendPreflightCalibrationCommand as (
      options?: { timeoutMs?: number },
    ) => Promise<void>,
  };
}

function authenticate(socket: FakeSocket) {
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
  assert.deepEqual(JSON.parse(socket.sent[1]!), { type: 'start-timing-calibration' });
}

test('no-Song preflight authenticates and waits for its boot-probe timing acknowledgement', async () => {
  const { sockets, sendPreflightCalibrationCommand } = harness();

  let resolved = false;
  const command = sendPreflightCalibrationCommand({ timeoutMs: 1_000 }).then(() => {
    resolved = true;
  });
  assert.equal(sockets.length, 1);
  const socket = sockets[0]!;
  assert.equal(socket.url, 'wss://relay.test/ws?key=room-key');

  authenticate(socket);

  await Promise.resolve();
  assert.equal(resolved, false, 'sending alone must not reopen the visible action before server status arrives');
  assert.equal(socket.readyState, FakeSocket.OPEN);

  socket.emit('message', {
    data: JSON.stringify({
      type: 'timing-calibration-status',
      state: 'idle',
      probeActive: false,
      probePhase: 'idle',
    }),
  });
  await Promise.resolve();
  assert.equal(resolved, false, 'an unrelated timing broadcast must not acknowledge this command');
  assert.equal(socket.readyState, FakeSocket.OPEN);

  socket.emit('message', {
    data: JSON.stringify({
      type: 'timing-calibration-status',
      state: 'idle',
      probeActive: true,
      probePhase: 'mic-requested',
    }),
  });

  await command;
  assert.equal(resolved, true);
  assert.equal(socket.readyState, FakeSocket.CLOSED);
});

test('no-Song preflight rejects immediately on calibration-specific policy rejection', async () => {
  const { sockets, sendPreflightCalibrationCommand } = harness();
  const command = sendPreflightCalibrationCommand({ timeoutMs: 1_000 });
  const socket = sockets[0]!;

  authenticate(socket);
  socket.emit('message', {
    data: JSON.stringify({
      type: 'calibration-command-rejected',
      reason: 'take-active',
    }),
  });

  await assert.rejects(command, /take-active/);
  assert.equal(socket.readyState, FakeSocket.CLOSED);
});
