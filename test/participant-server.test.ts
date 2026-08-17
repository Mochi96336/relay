import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import WebSocket from 'ws';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_PARTICIPANT_GRACE_MS: '250',
  RELAY_MIC_TRANSPORT_GRACE_MS: '250',
};

function participantQuery(id: string, nickname: string) {
  const params = new URLSearchParams({ participant: id, name: nickname });
  return `?${params.toString()}`;
}

async function connectParticipant(server: Awaited<ReturnType<typeof startRelay>>, id: string, nickname: string) {
  return RelayClient.connect(server, participantQuery(id, nickname));
}

function registerPublisher(
  client: RelayClient,
  captureGeneration: number,
  takeoverExpectedOwnerId?: string,
) {
  client.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration,
    ...(takeoverExpectedOwnerId ? { takeoverExpectedOwnerId } : {}),
  });
}

async function waitForNewMessage(
  client: RelayClient,
  startIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(startIndex).find(predicate);
    if (found) return found;
    await sleep(10);
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for a new message. `
    + `Saw after index ${startIndex}: ${client.messages.slice(startIndex).map((message) => message.type).join(', ')}`,
  );
}

describe('participant presence and microphone ownership', () => {
  test('commits a confirmed takeover together with a ready publisher transport', async () => {
    const server = await startRelay(FAST);
    try {
      const alicePresence = await connectParticipant(server, 'participant-alice', 'Alice');
      const bobPresence = await connectParticipant(server, 'participant-bobby', 'Bob');
      const alicePublisher = await connectParticipant(server, 'participant-alice', 'Alice');

      registerPublisher(alicePublisher, 1);
      await alicePublisher.waitForType('registered');
      await bobPresence.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === true
      ));

      const bobPublisher = await connectParticipant(server, 'participant-bobby', 'Bob');
      registerPublisher(bobPublisher, 2);
      const busy = await bobPublisher.waitForType('mic-busy');
      assert.equal(busy.owner.id, 'participant-alice');
      assert.equal(busy.owner.nickname, 'Alice');
      assert.equal(alicePublisher.messages.some((message) => message.type === 'mic-revoked'), false);

      registerPublisher(bobPublisher, 2, 'participant-alice');
      const registered = await bobPublisher.waitFor((message) => (
        message.type === 'registered' && message.role === 'publisher' && message.takeover === true
      ));
      assert.equal(registered.takeover, true);

      const revoked = await alicePublisher.waitForType('mic-revoked');
      assert.match(revoked.message, /Bob/);

      const ownedByBob = await bobPresence.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-bobby'
        && message.micConnected === true
      ));
      assert.equal(ownedByBob.micConnected, true);
      assert.equal(
        bobPresence.messages.some((message) => (
          message.type === 'session-status'
          && message.micOwnerId === 'participant-bobby'
          && message.micConnected === false
        )),
        false,
        'ownership must not be broadcast before the winning publisher is bound',
      );

      alicePresence.close();
      bobPresence.close();
      bobPublisher.close();
    } finally {
      await server.stop();
    }
  });

  test('rejects a stale takeover registration after a third participant changes ownership', async () => {
    const server = await startRelay(FAST);
    try {
      const alicePresence = await connectParticipant(server, 'participant-alice', 'Alice');
      const bobPresence = await connectParticipant(server, 'participant-bobby', 'Bob');
      const carolPresence = await connectParticipant(server, 'participant-carol', 'Carol');
      const alicePublisher = await connectParticipant(server, 'participant-alice', 'Alice');

      registerPublisher(alicePublisher, 1);
      await alicePublisher.waitForType('registered');

      const carolPublisher = await connectParticipant(server, 'participant-carol', 'Carol');
      registerPublisher(carolPublisher, 3, 'participant-alice');
      await carolPublisher.waitForType('registered');
      await carolPresence.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-carol'
        && message.micConnected === true
      ));

      const bobPublisher = await connectParticipant(server, 'participant-bobby', 'Bob');
      registerPublisher(bobPublisher, 2, 'participant-alice');
      const rejected = await bobPublisher.waitForType('mic-takeover-rejected');
      assert.equal(rejected.reason, 'owner-changed');
      assert.equal(rejected.owner.id, 'participant-carol');
      assert.equal(carolPublisher.messages.some((message) => message.type === 'mic-revoked'), false);

      const statusStart = bobPublisher.messages.length;
      bobPublisher.send({ type: 'session-status-request' });
      const status = await waitForNewMessage(bobPublisher, statusStart, (message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-carol'
        && message.micConnected === true
      ));
      assert.equal(status.micOwnerId, 'participant-carol');

      alicePresence.close();
      bobPresence.close();
      carolPresence.close();
      bobPublisher.close();
      carolPublisher.close();
    } finally {
      await server.stop();
    }
  });

  test('expires a missing publisher independently while the participant presence stays online', async () => {
    const server = await startRelay(FAST);
    try {
      const observer = await connectParticipant(server, 'participant-watch', 'Watcher');
      const alicePresence = await connectParticipant(server, 'participant-alice', 'Alice');
      const alicePublisher = await connectParticipant(server, 'participant-alice', 'Alice');
      registerPublisher(alicePublisher, 7);
      await alicePublisher.waitForType('registered');
      await observer.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === true
      ));

      const missingStart = observer.messages.length;
      alicePublisher.close();
      const transportMissing = await waitForNewMessage(observer, missingStart, (message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === false
        && message.participants.some((participant: any) => (
          participant.id === 'participant-alice' && participant.connected === true
        ))
      ));
      assert.equal(transportMissing.micOwnerId, 'participant-alice');

      await sleep(100);
      const reconnectedPublisher = await connectParticipant(server, 'participant-alice', 'Alice');
      const reconnectedStart = observer.messages.length;
      registerPublisher(reconnectedPublisher, 7);
      await reconnectedPublisher.waitForType('registered');
      await waitForNewMessage(observer, reconnectedStart, (message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === true
      ));

      const releaseStart = observer.messages.length;
      reconnectedPublisher.close();
      const released = await waitForNewMessage(observer, releaseStart, (message) => (
        message.type === 'session-status'
        && message.micOwnerId === null
        && message.participants.some((participant: any) => (
          participant.id === 'participant-alice' && participant.connected === true
        ))
      ), 3_000);
      assert.equal(released.micOwnerId, null);

      alicePresence.close();
      observer.close();
    } finally {
      await server.stop();
    }
  });

  test('release-mic frees the lease even when the participant presence remains connected', async () => {
    const server = await startRelay(FAST);
    try {
      const observer = await connectParticipant(server, 'participant-watch', 'Watcher');
      const alicePresence = await connectParticipant(server, 'participant-alice', 'Alice');
      const alicePublisher = await connectParticipant(server, 'participant-alice', 'Alice');
      registerPublisher(alicePublisher, 11);
      await alicePublisher.waitForType('registered');
      await observer.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === true
      ));

      const releaseStart = observer.messages.length;
      alicePresence.send({ type: 'release-mic' });
      await alicePublisher.waitForType('mic-revoked');
      const released = await waitForNewMessage(observer, releaseStart, (message) => (
        message.type === 'session-status'
        && message.micOwnerId === null
        && message.participants.some((participant: any) => (
          participant.id === 'participant-alice' && participant.connected === true
        ))
      ));
      assert.equal(released.micOwnerId, null);

      alicePresence.close();
      observer.close();
    } finally {
      await server.stop();
    }
  });

  test('supersedes a second tab semantically without a generic reconnecting error', async () => {
    const server = await startRelay(FAST);
    try {
      const observer = await connectParticipant(server, 'participant-watch', 'Watcher');
      const alicePresence = await connectParticipant(server, 'participant-alice', 'Alice');
      const firstPublisher = await connectParticipant(server, 'participant-alice', 'Alice');
      registerPublisher(firstPublisher, 21);
      await firstPublisher.waitForType('registered');
      await observer.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === true
      ));

      const replacementStart = observer.messages.length;
      const secondPublisher = await connectParticipant(server, 'participant-alice', 'Alice');
      registerPublisher(secondPublisher, 22);
      await secondPublisher.waitForType('registered');
      const superseded = await firstPublisher.waitForType('publisher-superseded');
      assert.match(superseded.message, /newer microphone capture/i);
      assert.deepEqual(firstPublisher.errors, []);

      const stillOwned = await waitForNewMessage(observer, replacementStart, (message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === true
      ));
      assert.equal(stillOwned.micOwnerId, 'participant-alice');

      alicePresence.close();
      secondPublisher.close();
      observer.close();
    } finally {
      await server.stop();
    }
  });

  test('does not turn ambient cookies or anonymous infrastructure sockets into participants', async () => {
    const server = await startRelay(FAST);
    try {
      const alice = await connectParticipant(server, 'participant-alice', 'Alice');
      await alice.waitFor((message) => (
        message.type === 'session-status'
        && message.participants.some((participant: any) => participant.id === 'participant-alice')
      ));

      const anonymousStatus = await new Promise<Record<string, any>>((resolve, reject) => {
        const ws = new WebSocket(server.wsUrl(), {
          headers: {
            cookie: 'relayParticipantId=participant-cookie; relayNickname=Cookie%20Ghost',
          },
        });
        const timer = setTimeout(() => reject(new Error('anonymous status timeout')), 3_000);
        ws.once('open', () => ws.send(JSON.stringify({ type: 'session-status-request' })));
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const message = JSON.parse(data.toString());
          if (message.type !== 'session-status') return;
          clearTimeout(timer);
          ws.close();
          resolve(message);
        });
        ws.once('error', reject);
      });

      assert.equal(
        anonymousStatus.participants.some((participant: any) => participant.id === 'participant-cookie'),
        false,
      );
      assert.equal(anonymousStatus.participants.length, 1);
      alice.close();
    } finally {
      await server.stop();
    }
  });

  test('does not allow a presence socket to reserve mic ownership before publisher registration', async () => {
    const server = await startRelay(FAST);
    try {
      const alice = await connectParticipant(server, 'participant-alice', 'Alice');
      const statusStart = alice.messages.length;
      alice.send({ type: 'acquire-mic' });
      const error = await alice.waitForType('error');
      assert.match(error.message, /publisher registration/);

      alice.send({ type: 'session-status-request' });
      const status = await waitForNewMessage(alice, statusStart, (message) => (
        message.type === 'session-status' && message.micOwnerId === null
      ));
      assert.equal(status.micOwnerId, null);
      alice.close();
    } finally {
      await server.stop();
    }
  });

  test('production websocket identities cannot bypass capability binding with a legacy-shaped id', async () => {
    const server = await startRelay({
      ...FAST,
      NODE_ENV: 'production',
      RELAY_TEST_LEGACY_PARTICIPANTS: '1',
    });
    try {
      const legacy = await RelayClient.connect(
        server,
        participantQuery('participant-alice', 'Alice'),
      );
      const rejected = await legacy.waitForType('participant-auth-rejected');
      assert.match(rejected.message, /capability/i);
      legacy.close();
    } finally {
      await server.stop();
    }
  });

});
