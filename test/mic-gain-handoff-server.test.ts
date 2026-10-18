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
  options: { takeoverExpectedOwnerId?: string; micGainDb?: unknown; premixed?: boolean; localFileTitle?: unknown } = {},
) {
  const publisher = await connect(server, id, name);
  publisher.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration,
    ...(options.takeoverExpectedOwnerId ? { takeoverExpectedOwnerId: options.takeoverExpectedOwnerId } : {}),
    ...('micGainDb' in options ? { micGainDb: options.micGainDb } : {}),
    ...(options.premixed ? { premixed: true } : {}),
    ...('localFileTitle' in options ? { localFileTitle: options.localFileTitle } : {}),
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

test('Mic gain follows the device across handoffs instead of staying with the room', async () => {
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
    // Each page remembers its own last gain and names it when it registers.
    const aliceAgain = await publish(server, 'participant-alice', 'Alice', 3, { micGainDb: 10 });
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'mix-settings' && message.micGainDb === 10
    ));
    assert.equal(await publisherGain(aliceAgain), 10, 'Alice gets back the gain she chose');

    from = observer.messages.length;
    bobPublisher = await publish(server, 'participant-bobby', 'Bob', 4, {
      takeoverExpectedOwnerId: 'participant-alice',
      micGainDb: 33,
    });
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

test('a registered Mic gain is clamped, and an unusable one falls back to the default', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await connect(server, 'participant-watch', 'Watcher');
    const alice = await connect(server, 'participant-alice', 'Alice');
    const bob = await connect(server, 'participant-bobby', 'Bob');

    const loud = await publish(server, 'participant-alice', 'Alice', 1, { micGainDb: 99 });
    assert.equal(await publisherGain(loud), 40, 'clamped to the same ceiling as set-mix');
    await release(alice, loud, observer);

    const garbled = await publish(server, 'participant-bobby', 'Bob', 2, { micGainDb: 'loud' });
    assert.equal(await publisherGain(garbled), 24);

    for (const client of [observer, alice, bob, garbled]) client.close();
  } finally {
    await server.stop();
  }
});

test('a premixed capture is mixed at unity until the next ordinary capture', async () => {
  const server = await startRelay(FAST);
  const statusz = async () => (await fetch(server.httpUrl('/statusz')).then((response) => response.json()) as any).audio;
  try {
    const observer = await connect(server, 'participant-watch', 'Watcher');
    await connect(server, 'participant-alice', 'Alice');
    let from = observer.messages.length;
    const premixed = await publish(server, 'participant-alice', 'Alice', 1,
      { premixed: true, localFileTitle: '  My\u0007 Song  ' });
    // Everyone's page learns the room's song is the Mic owner's local file.
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'product-status' && message.room?.localFile?.title === 'My Song'
    ));
    from = observer.messages.length;
    premixed.send({ type: 'set-local-file', title: 'Second song' });
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'product-status' && message.room?.localFile?.title === 'Second song'
    ));
    let mic = await statusz();
    assert.equal(mic.micPremixed, true);
    assert.equal(mic.micLevel.micGainDb, 24, 'the room setting is kept for the next ordinary capture');

    // Closing the local file starts a new capture without the flag.
    from = observer.messages.length;
    const ordinary = await publish(server, 'participant-alice', 'Alice', 2);
    await waitForNewMessage(observer, from, (message) => (
      message.type === 'product-status' && message.room?.mic?.ownerId && !message.room?.localFile
    ));
    await premixed.waitForType('publisher-superseded');
    mic = await statusz();
    assert.equal(mic.micPremixed, false);
    assert.equal(mic.micLevel.micGainDb, 24);
    ordinary.close();
  } finally {
    await server.stop();
  }
});
