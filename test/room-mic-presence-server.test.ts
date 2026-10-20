import assert from 'node:assert/strict';
import test from 'node:test';

import { participantIdFor, RelayClient, sleep, startRelay } from './helpers/harness.js';
import { uplinkHealthReport } from './support/uplink-health.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

function pcm(ms = 40) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

function uplinkHealth(captureGeneration: number, capturedSamples: number) {
  return {
    type: 'audio-uplink-health',
    ...uplinkHealthReport(captureGeneration, capturedSamples, {
      inputGapActive: false,
      capture: null,
      captureLevel: null,
      transport: { datagramPacketBytesCeiling: null, datagramQueuePackets: null, webSocketPacketsSent: 1 },
    }),
  };
}

function evidence(captureGeneration: number) {
  return {
    type: 'mic-presence-telemetry',
    version: 1,
    captureGeneration,
    rmsDbfs: -31.5,
    spectrumBands: [0.12, 0.48, 1, 0.37, 0.08],
    f0Hz: 220.4,
    pitchConfidence: 0.91,
  };
}

test('only the authoritative singer and current capture generation can relay truthful Mic F0 evidence', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await RelayClient.connectAs(server, 'presence-observer', 'Observer');
    const singerMedia = await RelayClient.connectAs(server, 'presence-singer', 'Singer');
    const singerStatus = await RelayClient.connectAs(server, 'presence-singer', 'Singer');

    singerMedia.send({
      type: 'register',
      role: 'publisher',
      sampleRate: RATE,
      captureGeneration: singerMedia.generationId,
      initialSequence: singerMedia.packetSequenceId,
      audioPacketVersion: 2,
    });
    await singerMedia.waitForType('registered');
    const firstPcm = pcm();
    singerMedia.sendAudioPacket(firstPcm);
    singerMedia.send(uplinkHealth(singerMedia.generationId, firstPcm.byteLength / 2));
    await sleep(60);

    const beforeForgery = observer.messages.length;
    observer.send(evidence(singerMedia.generationId));
    await sleep(120);
    assert.equal(
      observer.messages.slice(beforeForgery).some((message) => message.type === 'room-mic-presence'),
      false,
      'a listener must not be able to manufacture room Mic evidence',
    );

    const beforeWrongGeneration = observer.messages.length;
    singerStatus.send(evidence((singerMedia.generationId + 1) >>> 0));
    await sleep(120);
    assert.equal(
      observer.messages.slice(beforeWrongGeneration).some((message) => message.type === 'room-mic-presence'),
      false,
      'stale/wrong capture generations must not survive a capture restart',
    );

    const currentEvidence = evidence(singerMedia.generationId);
    singerStatus.send(currentEvidence);
    const relayed = await observer.waitFor((message) => (
      message.type === 'room-mic-presence'
      && message.ownerId === participantIdFor('presence-singer')
    ));

    assert.equal(relayed.version, 1);
    assert.equal(relayed.captureGeneration, singerMedia.generationId);
    assert.equal(relayed.rmsDbfs, currentEvidence.rmsDbfs);
    assert.deepEqual(relayed.spectrumBands, currentEvidence.spectrumBands);
    assert.equal(relayed.f0Hz, currentEvidence.f0Hz);
    assert.equal(relayed.pitchConfidence, currentEvidence.pitchConfidence);

    // Display telemetry goes to every listener, so the broadcast carries only
    // what the presence display can show, whatever precision the page sent.
    singerMedia.sendAudioPacket(pcm());
    await sleep(80);
    const beforePrecise = observer.messages.length;
    singerStatus.send({
      ...evidence(singerMedia.generationId),
      rmsDbfs: -31.47281934712345,
      spectrumBands: [0.1234567891, 0.4876543219, 1, 0.3712345678, 0.0812345678],
      f0Hz: 220.43749283748273,
      pitchConfidence: 0.9134287342873428,
    });
    const rounded = await observer.waitFor((message) => (
      message.type === 'room-mic-presence'
      && observer.messages.indexOf(message) >= beforePrecise
    ));
    assert.deepEqual(
      {
        rmsDbfs: rounded.rmsDbfs,
        spectrumBands: rounded.spectrumBands,
        f0Hz: rounded.f0Hz,
        pitchConfidence: rounded.pitchConfidence,
      },
      {
        rmsDbfs: -31.5,
        spectrumBands: [0.123, 0.488, 1, 0.371, 0.081],
        f0Hz: 220.4,
        pitchConfidence: 0.91,
      },
    );

    singerStatus.close();
    singerMedia.close();
    observer.close();
  } finally {
    await server.stop();
  }
});
