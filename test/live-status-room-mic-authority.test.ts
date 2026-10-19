import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeCustomEvent, FakeEvent, FakeNode, FakeWebSocket, FakeWindow } from './support/live-status-dom.js';

function productStatus(ownerId: string | null) {
  const live = ownerId !== null;
  return {
    type: 'product-status',
    lifecycle: live ? 'live' : 'idle',
    health: 'healthy',
    attention: null,
    room: {
      participantCount: 1,
      mic: {
        state: live ? 'live' : 'free',
        ownerId,
        ownerNickname: live ? 'Singer B' : null,
      },
      song: { state: 'empty', videoId: null, handoffState: 'idle' },
    },
    timing: { state: 'idle' },
    take: { lifecycle: 'idle' },
  };
}

function presence(ownerId: string, generation = 1) {
  return {
    type: 'room-mic-presence',
    version: 1,
    ownerId,
    captureGeneration: generation,
    rmsDbfs: -24,
    spectrumBands: [0.2, 0.3, 0.4, 0.3, 0.2],
    f0Hz: 220,
    pitchConfidence: 0.9,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('late Room Mic telemetry cannot poison live-status owner cache and clear the current waveform', async () => {
  const fakeWindow = new FakeWindow({ participantId: 'interaction-viewer' });
  const body = new FakeNode();
  const meter = new FakeNode();
  const nodes = new Map<string, FakeNode>([
    ['#live-state-title', new FakeNode()],
    ['#live-state-detail', new FakeNode()],
    ['#system-attention', new FakeNode()],
    ['#attention-link', new FakeNode()],
    ['#attention-copy', new FakeNode()],
    ['#system-panel', new FakeNode()],
    ['#system-relay', new FakeNode()],
    ['#system-phones', new FakeNode()],
    ['#system-robot', new FakeNode()],
    ['#system-audio', new FakeNode()],
    ['#system-timing', new FakeNode()],
    ['#system-recording', new FakeNode()],
    ['#mic-input-meter', meter],
  ]);
  const fakeDocument = {
    body,
    querySelector(selector: string) {
      return nodes.get(selector) ?? null;
    },
  };

  const globals = globalThis as any;
  const previous = {
    window: globals.window,
    document: globals.document,
    location: globals.location,
    WebSocket: globals.WebSocket,
    Event: globals.Event,
    CustomEvent: globals.CustomEvent,
  };
  globals.window = fakeWindow;
  globals.document = fakeDocument;
  globals.location = { protocol: 'http:', search: '', host: 'relay.test' };
  globals.WebSocket = FakeWebSocket;
  globals.Event = FakeEvent;
  globals.CustomEvent = FakeCustomEvent;

  try {
    const nonce = `${Date.now()}-${Math.random()}`;
    const presenceModule = new URL('../public/mic-presence.js', import.meta.url);
    presenceModule.searchParams.set('live-status-authority-test', nonce);
    await import(presenceModule.href);

    const statusModule = new URL('../public/live-status.js', import.meta.url);
    statusModule.searchParams.set('live-status-authority-test', nonce);
    await import(statusModule.href);
    await flush();

    const socket = FakeWebSocket.latest;
    assert.ok(socket, 'live-status should open its ProductStatus socket');

    socket.emit(productStatus('owner-b'));
    socket.emit(presence('owner-b', 2));
    assert.equal(meter.dataset.active, 'true', 'current owner B evidence starts the waveform');
    assert.equal(body.dataset.roomMic, 'live');

    socket.emit(presence('owner-a', 1));
    assert.equal(
      meter.dataset.active,
      'true',
      'late owner A telemetry is rejected without disturbing current owner B evidence',
    );

    socket.emit(productStatus('owner-b'));
    assert.equal(
      meter.dataset.active,
      'true',
      'replaying owner B ProductStatus must not falsely look like an owner change after late A telemetry',
    );
    assert.equal(body.dataset.roomMic, 'live');

    socket.emit(productStatus(null));
    assert.equal(meter.dataset.active, 'false');
    assert.equal(body.dataset.roomMic, 'off');
  } finally {
    globals.window = previous.window;
    globals.document = previous.document;
    globals.location = previous.location;
    globals.WebSocket = previous.WebSocket;
    globals.Event = previous.Event;
    globals.CustomEvent = previous.CustomEvent;
    FakeWebSocket.latest = null;
  }
});
