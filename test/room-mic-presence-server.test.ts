import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

function pcm(ms = 40) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
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
    const observer = await RelayClient.connect(server, '?participant=presence-observer&name=Observer');
    const singerMedia = await RelayClient.connect(server, '?participant=presence-singer&name=Singer');
    const singerStatus = await RelayClient.connect(server, '?participant=presence-singer&name=Singer');

    singerMedia.send({
      type: 'register',
      role: 'publisher',
      sampleRate: RATE,
      captureGeneration: singerMedia.generationId,
      initialSequence: singerMedia.packetSequenceId,
      audioPacketVersion: 2,
    });
    await singerMedia.waitForType('registered');
    singerMedia.sendAudioPacket(pcm());
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
      && message.ownerId === 'presence-singer'
    ));

    assert.equal(relayed.version, 1);
    assert.equal(relayed.captureGeneration, singerMedia.generationId);
    assert.equal(relayed.rmsDbfs, currentEvidence.rmsDbfs);
    assert.deepEqual(relayed.spectrumBands, currentEvidence.spectrumBands);
    assert.equal(relayed.f0Hz, currentEvidence.f0Hz);
    assert.equal(relayed.pitchConfidence, currentEvidence.pitchConfidence);

    singerStatus.close();
    singerMedia.close();
    observer.close();
  } finally {
    await server.stop();
  }
});
