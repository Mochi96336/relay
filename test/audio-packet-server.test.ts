import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;

function pcm(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt16LE(value, 0);
  buffer.writeInt16LE(value, 2);
  return buffer;
}

function participantQuery(id: string, nickname: string) {
  const params = new URLSearchParams({ participant: id, name: nickname });
  return `?${params.toString()}`;
}

async function waitForBinaryFrames(client: RelayClient, count: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.binaryFrames >= count) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${count} binary frames; saw ${client.binaryFrames}`);
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: any) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = client.messages.slice(fromIndex).find(predicate);
    if (match) return match;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for a new matching message after index ${fromIndex}`);
}

function registerV2(client: RelayClient, generation: number) {
  client.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration: generation,
    audioPacketVersion: 2,
  });
}

test('v2 media stays ordered and capture-authoritative across websocket reconnects', async () => {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_HEARTBEAT_MS: '60000',
    RELAY_PARTICIPANT_GRACE_MS: '500',
    RELAY_MIC_TRANSPORT_GRACE_MS: '500',
    RELAY_AUDIO_REORDER_WINDOW_PACKETS: '4',
    RELAY_AUDIO_REORDER_DEADLINE_MS: '100',
    RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS: '32',
  });

  try {
    const presence = await RelayClient.connect(server, participantQuery('participant-alice', 'Alice'));
    const monitor = await RelayClient.connect(server);
    monitor.send({ type: 'register', role: 'monitor' });
    await monitor.waitForType('registered');

    const publisher = await RelayClient.connect(server, participantQuery('participant-alice', 'Alice'));
    registerV2(publisher, 7);
    await publisher.waitForType('registered');
    await presence.waitFor(
      (message) => message.type === 'session-status' && message.micConnected === true,
    );

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 0, firstSampleIndex: 0, pcm: pcm(10),
    }));
    await waitForBinaryFrames(monitor, 1);

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 2, firstSampleIndex: 4, pcm: pcm(30),
    }));
    await sleep(30);
    assert.equal(monitor.binaryFrames, 1, 'packet 2 waits for packet 1 inside the reorder window');

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 1, firstSampleIndex: 2, pcm: pcm(20),
    }));
    await waitForBinaryFrames(monitor, 3);

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 2, firstSampleIndex: 4, pcm: pcm(30),
    }));
    publisher.sendUnheaderedPcm(pcm(99));
    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 6, sequence: 3, firstSampleIndex: 6, pcm: pcm(40),
    }));
    await sleep(30);
    assert.equal(monitor.binaryFrames, 3, 'duplicates, malformed v2 and wrong generations are rejected');

    const closeFrom = presence.messages.length;
    publisher.close();
    await waitForNewMessage(
      presence,
      closeFrom,
      (message) => message.type === 'session-status' && message.micConnected === false,
    );

    const reconnected = await RelayClient.connect(server, participantQuery('participant-alice', 'Alice'));
    registerV2(reconnected, 7);
    await reconnected.waitForType('registered');
    reconnected.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 3, firstSampleIndex: 6, pcm: pcm(40),
    }));
    await waitForBinaryFrames(monitor, 4);

    const freshCapture = await RelayClient.connect(server, participantQuery('participant-alice', 'Alice'));
    registerV2(freshCapture, 8);
    await freshCapture.waitForType('registered');

    freshCapture.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 4, firstSampleIndex: 8, pcm: pcm(50),
    }));
    await sleep(20);
    assert.equal(monitor.binaryFrames, 4, 'media cannot switch generation without control registration');

    freshCapture.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 8, sequence: 0, firstSampleIndex: 0, pcm: pcm(60),
    }));
    await waitForBinaryFrames(monitor, 5);

    presence.close();
    reconnected.close();
    freshCapture.close();
    monitor.close();
  } finally {
    await server.stop();
  }
});
