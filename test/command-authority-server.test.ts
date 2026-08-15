import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for new message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

async function participant(
  server: Awaited<ReturnType<typeof startRelay>>,
  id: string,
  name: string,
  role: 'publisher' | 'monitor' | null = null,
) {
  const client = await RelayClient.connect(
    server,
    `?participant=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`,
  );
  if (role) {
    client.send(role === 'publisher'
      ? { type: 'register', role, sampleRate: RATE, captureGeneration: 1 }
      : { type: 'register', role });
    await client.waitFor((message) => message.type === 'registered' && message.role === role);
  }
  return client;
}

test('shared mix and timing commands belong to the current Mic owner, not an arbitrary socket', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const ownerPublisher = await participant(server, 'participant-owner', 'Owner', 'publisher');
    const ownerControl = await participant(server, 'participant-owner', 'Owner', 'monitor');
    const other = await participant(server, 'participant-other', 'Other', 'monitor');

    let from = other.messages.length;
    other.send({ type: 'set-mix', micGainDb: 3, songLevel: 5 });
    const mixRejected = await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'command-rejected' && message.command === 'set-mix',
    );
    assert.equal(mixRejected.reason, 'not-mic-owner');
    assert.equal(mixRejected.owner?.id, 'participant-owner');

    from = other.messages.length;
    ownerControl.send({ type: 'set-mix', micGainDb: 17, songLevel: 27 });
    const settings = await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'mix-settings' && message.songLevel === 27,
    );
    assert.equal(settings.micGainDb, 17);

    from = other.messages.length;
    other.send({ type: 'set-vocal-fine-tune', valueMs: 75 });
    const fineTuneRejected = await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'command-rejected' && message.command === 'set-vocal-fine-tune',
    );
    assert.equal(fineTuneRejected.reason, 'not-mic-owner');

    from = other.messages.length;
    other.send({ type: 'source-status-request' });
    const sourceStatus = await waitForNewMessage(other, from, (message) => message.type === 'source-status');
    assert.equal(sourceStatus.vocalFineTuneMs, 0, 'rejected fine tune must not mutate mixer state');

    from = other.messages.length;
    other.send({ type: 'start-timing-calibration' });
    const recalibrateRejected = await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'command-rejected' && message.command === 'start-timing-calibration',
    );
    assert.equal(recalibrateRejected.reason, 'not-mic-owner');

    from = other.messages.length;
    other.send({ type: 'timing-calibration-status-request' });
    const calibration = await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'timing-calibration-status',
    );
    assert.notEqual(calibration.state, 'failed', 'unauthorized recalibrate must not run prerequisite checks');
    assert.notEqual(calibration.state, 'collecting');

    ownerPublisher.close();
    ownerControl.close();
    other.close();
  } finally {
    await server.stop();
  }
});

test('only the server-selected anonymous publisher keeps legacy command authority', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const publisher = await RelayClient.connect(server);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 7 });
    await publisher.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    const observer = await RelayClient.connect(server);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitFor((message) => message.type === 'registered' && message.role === 'monitor');

    let from = observer.messages.length;
    observer.send({ type: 'set-mix', micGainDb: 1, songLevel: 1 });
    const rejected = await waitForNewMessage(
      observer,
      from,
      (message) => message.type === 'command-rejected' && message.command === 'set-mix',
    );
    assert.equal(rejected.reason, 'mic-free');

    from = observer.messages.length;
    publisher.send({ type: 'set-mix', micGainDb: 12, songLevel: 33 });
    const accepted = await waitForNewMessage(
      observer,
      from,
      (message) => message.type === 'mix-settings' && message.songLevel === 33,
    );
    assert.equal(accepted.micGainDb, 12);

    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    from = robot.messages.length;
    robot.send({ type: 'set-mix', micGainDb: 30, songLevel: 99 });
    const robotRejected = await waitForNewMessage(
      robot,
      from,
      (message) => message.type === 'command-rejected' && message.command === 'set-mix',
    );
    assert.equal(robotRejected.reason, 'mic-free');

    publisher.close();
    observer.close();
    robot.close();
  } finally {
    await server.stop();
  }
});

test('another participant cannot stop the Mic owner sync test', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const ownerPublisher = await participant(server, 'participant-owner', 'Owner', 'publisher');
    const ownerControl = await participant(server, 'participant-owner', 'Owner', 'monitor');
    const other = await participant(server, 'participant-other', 'Other', 'monitor');

    let from = other.messages.length;
    ownerPublisher.send({ type: 'start-sync-test' });
    await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'test-status' && message.active === true,
    );

    from = other.messages.length;
    other.send({ type: 'stop-sync-test' });
    const rejected = await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'command-rejected' && message.command === 'stop-sync-test',
    );
    assert.equal(rejected.reason, 'not-mic-owner');

    const lateObserver = await participant(server, 'participant-third', 'Third', 'monitor');
    const current = lateObserver.latest('test-status');
    assert.equal(current?.active, true, 'rejected stop must leave the sync test running');

    from = other.messages.length;
    ownerControl.send({ type: 'stop-sync-test' });
    const stopped = await waitForNewMessage(
      other,
      from,
      (message) => message.type === 'test-status' && message.active === false,
    );
    assert.equal(stopped.active, false);

    ownerPublisher.close();
    ownerControl.close();
    other.close();
    lateObserver.close();
  } finally {
    await server.stop();
  }
});
