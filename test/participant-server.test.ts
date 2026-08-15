import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '1500',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_PARTICIPANT_GRACE_MS: '250',
};

function participantQuery(id: string, nickname: string) {
  const params = new URLSearchParams({ participant: id, name: nickname });
  return `?${params.toString()}`;
}

async function connectParticipant(server: Awaited<ReturnType<typeof startRelay>>, id: string, nickname: string) {
  return RelayClient.connect(server, participantQuery(id, nickname));
}

describe('participant presence and microphone ownership', () => {
  test('publishes presence and requires confirmation before another participant takes the mic', async () => {
    const server = await startRelay(FAST);
    try {
      const alice = await connectParticipant(server, 'participant-alice', 'Alice');
      await alice.waitFor((message) => (
        message.type === 'session-status'
        && message.participants.some((participant: any) => participant.nickname === 'Alice')
      ));

      const bob = await connectParticipant(server, 'participant-bobby', 'Bob');
      const both = await alice.waitFor((message) => (
        message.type === 'session-status'
        && message.participants.filter((participant: any) => participant.connected).length === 2
      ));
      assert.deepEqual(
        both.participants.map((participant: any) => participant.nickname).sort(),
        ['Alice', 'Bob'],
      );

      alice.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await alice.waitForType('registered');
      const ownedByAlice = await bob.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.micConnected === true
      ));
      assert.equal(ownedByAlice.micConnected, true);

      bob.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      const busy = await bob.waitForType('mic-busy');
      assert.equal(busy.owner.id, 'participant-alice');
      assert.equal(busy.owner.nickname, 'Alice');
      assert.deepEqual(alice.errors, [], 'a normal busy attempt must not evict the current singer');

      bob.send({
        type: 'force-acquire-mic',
        expectedOwnerId: 'participant-alice',
      });
      const revoked = await alice.waitForType('mic-revoked');
      assert.match(revoked.message, /Bob/);

      const ownedByBob = await bob.waitFor((message) => (
        message.type === 'session-status' && message.micOwnerId === 'participant-bobby'
      ));
      assert.equal(ownedByBob.micConnected, false, 'ownership changes before the new capture starts');

      bob.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      assert.equal((await bob.waitForType('registered')).role, 'publisher');
      const bobLive = await bob.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-bobby'
        && message.micConnected === true
      ));
      assert.equal(bobLive.micConnected, true);

      alice.close();
      bob.close();
    } finally {
      await server.stop();
    }
  });

  test('rejects a stale takeover confirmation after a third participant changes ownership', async () => {
    const server = await startRelay(FAST);
    try {
      const alice = await connectParticipant(server, 'participant-alice', 'Alice');
      const bob = await connectParticipant(server, 'participant-bobby', 'Bob');
      const carol = await connectParticipant(server, 'participant-carol', 'Carol');

      alice.send({ type: 'acquire-mic' });
      await alice.waitFor((message) => message.type === 'session-status' && message.micOwnerId === 'participant-alice');

      carol.send({ type: 'force-acquire-mic', expectedOwnerId: 'participant-alice' });
      await carol.waitFor((message) => message.type === 'session-status' && message.micOwnerId === 'participant-carol');

      bob.send({ type: 'force-acquire-mic', expectedOwnerId: 'participant-alice' });
      const rejected = await bob.waitForType('mic-takeover-rejected');
      assert.equal(rejected.reason, 'owner-changed');
      assert.equal(rejected.owner.id, 'participant-carol');

      bob.send({ type: 'session-status-request' });
      const status = await bob.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-carol'
        && message.revision >= rejected.revision
      ));
      assert.equal(status.micOwnerId, 'participant-carol');

      alice.close();
      bob.close();
      carol.close();
    } finally {
      await server.stop();
    }
  });

  test('keeps an offline owner during reconnect grace, then releases an abandoned mic', async () => {
    const server = await startRelay(FAST);
    try {
      const observer = await connectParticipant(server, 'participant-watch', 'Watcher');
      const alice = await connectParticipant(server, 'participant-alice', 'Alice');
      alice.send({ type: 'acquire-mic' });
      await observer.waitFor((message) => message.type === 'session-status' && message.micOwnerId === 'participant-alice');

      alice.close();
      const reconnecting = await observer.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.participants.some((participant: any) => (
          participant.id === 'participant-alice' && participant.connected === false
        ))
      ));
      assert.equal(reconnecting.micOwnerId, 'participant-alice');

      await sleep(100);
      const rejoined = await connectParticipant(server, 'participant-alice', 'Alice');
      const backOnline = await observer.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === 'participant-alice'
        && message.participants.some((participant: any) => (
          participant.id === 'participant-alice' && participant.connected === true
        ))
      ));
      assert.equal(backOnline.micOwnerId, 'participant-alice');

      rejoined.close();
      const released = await observer.waitFor((message) => (
        message.type === 'session-status'
        && message.micOwnerId === null
        && !message.participants.some((participant: any) => participant.id === 'participant-alice')
      ), 3_000);
      assert.equal(released.micOwnerId, null);

      observer.close();
    } finally {
      await server.stop();
    }
  });
});
