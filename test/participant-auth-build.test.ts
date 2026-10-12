import assert from 'node:assert/strict';
import test from 'node:test';

type Listener = (event: { data: unknown }) => void;

class FakeSocket {
  sent: string[] = [];
  private listeners = new Set<Listener>();
  addEventListener(_type: 'message', listener: Listener) { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: Listener) { this.listeners.delete(listener); }
  send(data: string) { this.sent.push(data); }
  receive(message: unknown) {
    for (const listener of [...this.listeners]) listener({ data: JSON.stringify(message) });
  }
  get listening() { return this.listeners.size; }
}

let instance = 0;

/** A fresh copy of the helper, as one page load serving `build` would run it. */
async function loadPage(build: string | null) {
  const announced: CustomEvent[] = [];
  Object.assign(globalThis, {
    document: {
      querySelector: (selector: string) => (selector === 'meta[name="relay-build"]' && build
        ? { getAttribute: (name: string) => (name === 'content' ? build : null) }
        : null),
    },
    window: {
      relayParticipantId: 'participant-a',
      relayParticipantCapability: 'capability-a',
      relayNickname: 'Alice',
      dispatchEvent: (event: CustomEvent) => announced.push(event),
    },
  });
  const url = new URL('../public/participant-auth.js', import.meta.url);
  url.search = `?page=${++instance}`;
  const helper = await import(url.href);
  return { helper, announced };
}

test('a page reports the build it was served with and stays quiet when Relay matches', async () => {
  const { helper, announced } = await loadPage('aaaaaaaaaaaa');
  const socket = new FakeSocket();
  assert.equal(helper.sendParticipantAuthentication(socket), true);
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    type: 'participant-authenticate',
    participantId: 'participant-a',
    capability: 'capability-a',
    nickname: 'Alice',
    build: 'aaaaaaaaaaaa',
  });

  socket.receive({ type: 'session-status' });
  assert.equal(socket.listening, 1, 'other messages do not end the watch');
  socket.receive({ type: 'participant-authenticated', participantId: 'participant-a', build: 'aaaaaaaaaaaa' });
  assert.equal(socket.listening, 0, 'one acknowledgement answers the question');
  assert.equal(announced.length, 0);
});

test('a page left open across an update announces it once, however many sockets reconnect', async () => {
  const { helper, announced } = await loadPage('aaaaaaaaaaaa');
  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  for (const socket of sockets) helper.sendParticipantAuthentication(socket);
  for (const socket of sockets) {
    socket.receive({ type: 'participant-authenticated', participantId: 'participant-a', build: 'bbbbbbbbbbbb' });
  }
  assert.equal(announced.length, 1);
  assert.equal(announced[0]!.type, 'relay-page-outdated');
  assert.deepEqual(announced[0]!.detail, { pageBuild: 'aaaaaaaaaaaa', relayBuild: 'bbbbbbbbbbbb' });

  const later = new FakeSocket();
  helper.sendParticipantAuthentication(later);
  assert.equal(later.listening, 0, 'nothing left to watch after the announcement');
});

test('a Relay that sends no build, or a page served without one, compares nothing', async () => {
  const { helper, announced } = await loadPage('aaaaaaaaaaaa');
  const socket = new FakeSocket();
  helper.sendParticipantAuthentication(socket);
  socket.receive({ type: 'participant-authenticated', participantId: 'participant-a' });
  assert.equal(announced.length, 0);

  const unbuilt = await loadPage(null);
  const plain = new FakeSocket();
  unbuilt.helper.sendParticipantAuthentication(plain);
  assert.equal('build' in JSON.parse(plain.sent[0]!), false);
  assert.equal(plain.listening, 0);
});
