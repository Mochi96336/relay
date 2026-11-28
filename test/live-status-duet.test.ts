import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeCustomEvent, FakeEvent, FakeNode, FakeWebSocket, FakeWindow } from './support/live-status-dom.js';

function productStatus(ownerId: string, duet: Record<string, unknown> | null) {
  return {
    type: 'product-status',
    lifecycle: 'live',
    health: 'healthy',
    attention: null,
    room: {
      participantCount: 3,
      mic: { state: 'live', ownerId, ownerNickname: 'Singer A' },
      ...(duet ? { duet } : {}),
      song: { state: 'empty', videoId: null, handoffState: 'idle' },
    },
    timing: { state: 'idle' },
    take: { lifecycle: 'idle' },
  };
}

async function flush() {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
}

test('the heading names the second singer for the owner, the second singer and everyone else', async () => {
  const fakeWindow = new FakeWindow({
    t: (key: string, vars?: Record<string, string>) => vars ? `${key}${JSON.stringify(vars)}` : key,
  });
  const title = new FakeNode();
  const detail = new FakeNode();
  const nodes = new Map<string, FakeNode>([
    ['#live-state-title', title], ['#live-state-detail', detail],
    ['#system-attention', new FakeNode()], ['#attention-link', new FakeNode()],
    ['#attention-copy', new FakeNode()], ['#system-panel', new FakeNode()],
    ['#system-relay', new FakeNode()], ['#system-phones', new FakeNode()],
    ['#system-robot', new FakeNode()], ['#system-audio', new FakeNode()],
    ['#system-timing', new FakeNode()], ['#system-recording', new FakeNode()],
    ['#mic-input-meter', new FakeNode()],
  ]);
  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document, location: globals.location,
    WebSocket: globals.WebSocket, Event: globals.Event, CustomEvent: globals.CustomEvent };
  globals.window = fakeWindow;
  globals.document = { body: new FakeNode(), querySelector: (s: string) => nodes.get(s) ?? null };
  globals.location = { protocol: 'http:', search: '', host: 'relay.test' };
  globals.WebSocket = FakeWebSocket;
  globals.Event = FakeEvent;
  globals.CustomEvent = FakeCustomEvent;
  try {
    const statusModule = new URL('../public/live-status.js', import.meta.url);
    statusModule.searchParams.set('live-status-duet-test', `${Date.now()}-${Math.random()}`);
    await import(statusModule.href);
    await flush();
    const socket = FakeWebSocket.latest!;
    const seats: unknown[] = [];
    fakeWindow.addEventListener('relay-room-second-mic', (event: any) => seats.push(event.detail.secondaryId));
    const duet = (state: string, secondaryId = 'viewer') => ({ secondaryId, secondaryNickname: '小明', state });

    socket.emit(productStatus('owner', duet('singing')));
    assert.equal(title.textContent, 'voice.duetPair{"owner":"Singer A","partner":"小明"}',
      'the singer’s other tab hears the pair as a listener');
    fakeWindow.dispatchEvent(new FakeCustomEvent('relay-choir-guest-state', { detail: { enabled: true } }));
    assert.equal(title.textContent, 'voice.duetYours{"name":"Singer A"}');

    // The second singer sees who they are singing with and how far along they are.
    for (const state of ['joined', 'aligning', 'singing']) {
      socket.emit(productStatus('owner', duet(state)));
      assert.equal(title.textContent, 'voice.duetYours{"name":"Singer A"}');
      assert.equal(detail.textContent, `voice.duet.self.${state}`);
    }

    fakeWindow.dispatchEvent(new FakeCustomEvent('relay-choir-guest-state', { detail: { enabled: false } }));
    assert.equal(title.textContent, 'voice.duetPair{"owner":"Singer A","partner":"小明"}');
    // The Mic owner keeps "you are singing" and sees who joined.
    fakeWindow.relayParticipantId = 'owner';
    for (const state of ['joined', 'aligning', 'singing']) {
      socket.emit(productStatus('owner', duet(state, 'friend')));
      assert.equal(title.textContent, 'voice.live');
      assert.equal(detail.textContent, `voice.duet.owner.${state}{"name":"小明"}`);
    }

    // Everyone else sees both names only once both voices are in the room.
    fakeWindow.relayParticipantId = 'listener';
    socket.emit(productStatus('owner', duet('aligning', 'friend')));
    assert.equal(title.textContent, 'Singer A');
    assert.equal(detail.textContent, 'voice.singing');
    socket.emit(productStatus('owner', duet('singing', 'friend')));
    assert.equal(title.textContent, 'voice.duetPair{"owner":"Singer A","partner":"小明"}');
    assert.equal(detail.textContent, 'voice.singing');

    // No duet: the ordinary heading.
    socket.emit(productStatus('owner', null));
    assert.equal(title.textContent, 'Singer A');
    assert.equal(detail.textContent, 'voice.singing');

    // Take history learns only who holds the second Mic, once per change,
    // and a late listener can ask for the current seat.
    assert.deepEqual(seats, ['viewer', 'friend', null]);
    fakeWindow.dispatchEvent(new FakeEvent('relay-request-room-second-mic'));
    assert.deepEqual(seats, ['viewer', 'friend', null, null]);
  } finally {
    Object.assign(globals, previous);
    FakeWebSocket.latest = null;
  }
});
