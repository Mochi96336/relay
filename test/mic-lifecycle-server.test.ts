import assert from 'node:assert/strict';
import test from 'node:test';

import {
  participantIdFor,
  RelayClient,
  sendPcmInChunks,
  startCalibrationCollecting,
  startRelay,
  tone,
  waitForNewMessage,
} from './helpers/harness.js';
import { playingRoomSong } from './support/client-commands.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '5000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
  RELAY_PARTICIPANT_GRACE_MS: '5000',
  RELAY_MIC_TRANSPORT_GRACE_MS: '5000',
};

function registerPublisher(client: RelayClient, captureGeneration: number) {
  client.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration });
}

test('a Mic that drops during calibration fails it at once', async () => {
  // The singer's lease outlives the dropped socket for the transport grace,
  // but a measurement of a capture that stopped arriving is already lost.
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connectInfrastructure(server);
    const monitor = await RelayClient.connectAs(server, 'listener', 'Listener');
    const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await Promise.all([
      backing.waitForType('registered'),
      monitor.waitForType('registered'),
      publisher.waitForType('registered'),
    ]);

    const songTelemetry = await playingRoomSong(publisher);
    const prime = async () => {
      publisher.send(songTelemetry());
      await Promise.all([
        sendPcmInChunks(backing, tone(0.5, 0.8)),
        sendPcmInChunks(publisher, tone(0.5, 0.4)),
      ]);
    };
    await prime();
    await startCalibrationCollecting(publisher, monitor, prime);

    const from = monitor.messages.length;
    const droppedAt = Date.now();
    publisher.close();

    const failed = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status' && message.state === 'failed'
    ));
    assert.equal(failed.error, 'Microphone disconnected during calibration.');
    assert.ok(Date.now() - droppedAt < 2_000, 'calibration does not wait out the transport grace');
  } finally {
    await server.stop();
  }
});

test('an explicit release revokes the publisher, acknowledges the releaser and frees the Mic at once', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await RelayClient.connectAs(server, 'participant-watch', 'Watcher');
    const alicePresence = await RelayClient.connectAs(server, 'participant-alice', 'Alice');
    const alicePublisher = await RelayClient.connectAs(server, 'participant-alice', 'Alice');
    registerPublisher(alicePublisher, 5);
    await alicePublisher.waitForType('registered');
    await observer.waitFor((message) => (
      message.type === 'session-status'
      && message.micOwnerId === participantIdFor('participant-alice')
      && message.micConnected === true
    ));

    const releaseFrom = observer.messages.length;
    alicePresence.send({ type: 'release-mic' });
    const revoked = await alicePublisher.waitForType('mic-revoked');
    assert.equal(revoked.message, 'You released the microphone.');
    await alicePresence.waitForType('mic-released');
    await waitForNewMessage(observer, releaseFrom, (message) => (
      message.type === 'session-status' && message.micOwnerId === null
    ));

    // Nothing of Alice's lease is left waiting on a grace: Bob takes the Mic
    // straight away, without a takeover.
    const bob = await RelayClient.connectAs(server, 'participant-bobby', 'Bob');
    const bobFrom = observer.messages.length;
    registerPublisher(bob, 9);
    await bob.waitForType('registered');
    const taken = await waitForNewMessage(observer, bobFrom, (message) => (
      message.type === 'session-status' && message.micConnected === true
    ));
    assert.equal(taken.micOwnerId, participantIdFor('participant-bobby'));
  } finally {
    await server.stop();
  }
});
