import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  startCalibrationCollecting,
  startRelay,
  toInt16,
  waitForNewMessage,
} from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_CALIBRATION_TIMEOUT_MS: '5000',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_AGREEMENT: '1',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_CALIBRATION_VALIDATION: '0',
  RELAY_PARTICIPANT_GRACE_MS: '5000',
  RELAY_MIC_TRANSPORT_GRACE_MS: '5000',
};

function participant(server: Awaited<ReturnType<typeof startRelay>>, id: string, nickname: string) {
  const params = new URLSearchParams({ participant: id, name: nickname });
  return RelayClient.connect(server, `?${params.toString()}`);
}

function registerPublisher(client: RelayClient, captureGeneration: number) {
  client.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration });
}

const playingStartedAtMs = Date.now();
function playingTelemetry() {
  return {
    type: 'youtube-telemetry',
    videoId: 'dQw4w9WgXcQ',
    state: 1,
    currentTime: 42 + (Date.now() - playingStartedAtMs) / 1_000,
    duration: 200,
    playbackRate: 1,
    networkRttMs: 40,
  };
}

function tone(seconds: number, gain: number) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, 5), gain);
}

test('a Mic without a lease that drops during calibration fails it and gives up its media at once', async () => {
  // A publisher with no participant identity holds no lease, so there is
  // nothing to keep for a reconnect. (The lease owner's reconnect grace is
  // covered in participant-server.test.ts.)
  const server = await startRelay(FAST);
  try {
    const backing = await RelayClient.connect(server);
    const monitor = await RelayClient.connect(server);
    const publisher = await RelayClient.connect(server);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    monitor.send({ type: 'register', role: 'monitor' });
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await Promise.all([
      backing.waitForType('registered'),
      monitor.waitForType('registered'),
      publisher.waitForType('registered'),
    ]);

    const prime = async () => {
      publisher.send(playingTelemetry());
      await Promise.all([
        sendPcmInChunks(backing, tone(0.5, 0.8)),
        sendPcmInChunks(publisher, tone(0.5, 0.4)),
      ]);
    };
    await prime();
    await startCalibrationCollecting(publisher, monitor, prime);

    const from = monitor.messages.length;
    publisher.close();

    const failed = await waitForNewMessage(monitor, from, (message) => (
      message.type === 'timing-calibration-status' && message.state === 'failed'
    ));
    assert.equal(failed.error, 'Microphone disconnected during calibration.');
    await waitForNewMessage(monitor, from, (message) => (
      message.type === 'source-status' && message.micConnected === false
    ));
    const status = await (await fetch(server.httpUrl('/statusz'))).json();
    assert.equal(status.audio.micSampleRate, null, 'no media is kept for a publisher that held no lease');
  } finally {
    await server.stop();
  }
});

test('an explicit release revokes the publisher, acknowledges the releaser and frees the Mic at once', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await participant(server, 'participant-watch', 'Watcher');
    const alicePresence = await participant(server, 'participant-alice', 'Alice');
    const alicePublisher = await participant(server, 'participant-alice', 'Alice');
    registerPublisher(alicePublisher, 5);
    await alicePublisher.waitForType('registered');
    await observer.waitFor((message) => (
      message.type === 'session-status'
      && message.micOwnerId === 'participant-alice'
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
    const bob = await participant(server, 'participant-bobby', 'Bob');
    const bobFrom = observer.messages.length;
    registerPublisher(bob, 9);
    await bob.waitForType('registered');
    const taken = await waitForNewMessage(observer, bobFrom, (message) => (
      message.type === 'session-status' && message.micConnected === true
    ));
    assert.equal(taken.micOwnerId, 'participant-bobby');
  } finally {
    await server.stop();
  }
});
