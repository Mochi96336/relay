import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, startRelay, waitForNewMessage } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_PARTICIPANT_GRACE_MS: '250',
  RELAY_MIC_TRANSPORT_GRACE_MS: '250',
};

async function connect(server: Awaited<ReturnType<typeof startRelay>>, id: string, name: string) {
  const params = new URLSearchParams({ participant: id, name });
  return RelayClient.connect(server, `?${params.toString()}`);
}

async function publish(
  server: Awaited<ReturnType<typeof startRelay>>,
  id: string,
  name: string,
  captureGeneration: number,
  takeoverExpectedOwnerId?: string,
) {
  const publisher = await connect(server, id, name);
  publisher.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration,
    ...(takeoverExpectedOwnerId ? { takeoverExpectedOwnerId } : {}),
  });
  await publisher.waitFor((message) => message.type === 'registered' && message.role === 'publisher');
  return publisher;
}

/** The gain the new owner's own page is handed with its initial state. */
async function publisherGain(publisher: RelayClient) {
  const registeredAt = publisher.messages.findIndex((message) => message.type === 'registered');
  const settings = await waitForNewMessage(
    publisher,
    registeredAt,
    (message) => message.type === 'mix-settings',
  );
  return settings.micGainDb;
}

async function release(presence: RelayClient, publisher: RelayClient, observer: RelayClient) {
  const from = observer.messages.length;
  presence.send({ type: 'release-mic' });
  await publisher.waitForType('mic-revoked');
  await waitForNewMessage(observer, from, (message) => (
    message.type === 'session-status' && message.micOwnerId === null
  ));
  publisher.close();
}

test('Mic gain follows the participant across handoffs instead of staying with the room', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await connect(server, 'participant-watch', 'Watcher');
    const alice = await connect(server, 'participant-alice', 'Alice');
    const bob = await connect(server, 'participant-bobby', 'Bob');

    const alicePublisher = await publish(server, 'participant-alice', 'Alice', 1);
    assert.equal(await publisherGain(alicePublisher), 24, 'a device never seen starts at the default');
    let from = observer.messages.length;
    alicePublisher.send({ type: 'set-mix', micGainDb: 10 });
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'mix-settings' && message.micGainDb === 10
    ));
    await release(alice, alicePublisher, observer);

    from = observer.messages.length;
    let bobPublisher = await publish(server, 'participant-bobby', 'Bob', 2);
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'mix-settings' && message.micGainDb === 24
    ));
    assert.equal(await publisherGain(bobPublisher), 24, "Bob must not inherit Alice's 10 dB");
    from = observer.messages.length;
    bobPublisher.send({ type: 'set-mix', micGainDb: 33 });
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'mix-settings' && message.micGainDb === 33
    ));
    await release(bob, bobPublisher, observer);

    from = observer.messages.length;
    const aliceAgain = await publish(server, 'participant-alice', 'Alice', 3);
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'mix-settings' && message.micGainDb === 10
    ));
    assert.equal(await publisherGain(aliceAgain), 10, 'Alice gets back the gain she chose');

    from = observer.messages.length;
    bobPublisher = await publish(server, 'participant-bobby', 'Bob', 4, 'participant-alice');
    await aliceAgain.waitForType('mic-revoked');
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'mix-settings' && message.micGainDb === 33
    ));
    assert.equal(await publisherGain(bobPublisher), 33, 'a takeover brings the new singer their own gain');

    for (const client of [observer, alice, bob, aliceAgain, bobPublisher]) client.close();
  } finally {
    await server.stop();
  }
});
