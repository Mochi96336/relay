import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

function participantQuery(id: string, nickname: string) {
  const params = new URLSearchParams({ participant: id, name: nickname });
  return `?${params.toString()}`;
}

function uplinkHealth(generation: number) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: generation,
    capturedSamples: 96_000,
    inputGapSamples: 128,
    inputMuted: false,
    capture: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      audioSessionType: 'play-and-record',
    },
    captureLevel: {
      peakDbfs: -18,
      rmsDbfs: -31,
    },
    droppedSamples: {
      total: 960,
      disconnected: 480,
      congested: 480,
      packetTooLarge: 0,
    },
    controlReconnects: 1,
    transport: {
      path: 'websocket',
      maxPacketBytes: null,
      minWebTransportMaxPacketBytes: null,
      maxWebTransportMaxPacketBytes: null,
      webTransportAttempts: 1,
      webTransportConnections: 0,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webSocketPacketsSent: 100,
      webSocketCongestedRejects: 2,
      webSocketDisconnectedRejects: 3,
      webSocketSendFailures: 0,
    },
  };
}

test('statusz separates browser uplink, receiver transport and timeline evidence', async () => {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_HEARTBEAT_MS: '60000',
  });

  try {
    const publisher = await RelayClient.connect(
      server,
      participantQuery('participant-audio-health', 'Audio Health'),
    );
    publisher.send({
      type: 'register',
      role: 'publisher',
      sampleRate: 48_000,
      captureGeneration: 7,
      audioPacketVersion: 2,
    });
    await publisher.waitForType('registered');

    publisher.send(uplinkHealth(7));
    await sleep(20);

    const status = await fetch(server.httpUrl('/statusz')).then((response) => response.json()) as any;
    assert.equal(status.audio.micMediaPath, 'websocket');
    assert.equal(status.audio.captureAndSender.captureGeneration, 7);
    assert.equal(status.audio.captureAndSender.inputGapSamples, 128);
    assert.equal(status.audio.captureAndSender.droppedSamples.disconnected, 480);
    assert.equal(status.audio.captureAndSender.transport.webSocketPacketsSent, 100);
    assert.deepEqual(status.audio.captureAndSender.capture, {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      audioSessionType: 'play-and-record',
    });
    assert.deepEqual(status.audio.captureAndSender.captureLevel, {
      peakDbfs: -18,
      rmsDbfs: -31,
    });
    assert.ok(status.audio.captureAndSender.reportAgeMs >= 0);
    assert.equal(typeof status.audio.receiverTransport.receivedPackets, 'number');
    assert.equal(typeof status.audio.timeline.micGapMs, 'number');

    const malformed: any = uplinkHealth(7);
    malformed.capturedSamples = 999_999;
    malformed.captureLevel = { peakDbfs: -40, rmsDbfs: -20 };
    publisher.send(malformed);
    await sleep(20);
    const afterMalformed = await fetch(server.httpUrl('/statusz')).then((response) => response.json()) as any;
    assert.equal(
      afterMalformed.audio.captureAndSender.capturedSamples,
      96_000,
      'malformed diagnostic telemetry must not replace the last valid capture state',
    );
    assert.deepEqual(afterMalformed.audio.captureAndSender.captureLevel, {
      peakDbfs: -18,
      rmsDbfs: -31,
    });

    publisher.send(uplinkHealth(6));
    await sleep(20);
    const stale = await fetch(server.httpUrl('/statusz')).then((response) => response.json()) as any;
    assert.equal(stale.audio.captureAndSender.captureGeneration, 7, 'wrong-generation telemetry is ignored');

    publisher.close();
  } finally {
    await server.stop();
  }
});