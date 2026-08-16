import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FRAME_SAMPLES = 960;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_LIVE_PREBUFFER_MS: '40',
};

function pcm(value = 4_000) {
  const frame = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) frame.writeInt16LE(value, i * 2);
  return frame;
}

function feedMic(client: RelayClient, frames: number, value = 4_000) {
  const frame = pcm(value);
  for (let i = 0; i < frames; i += 1) client.sendPcm(frame);
}

test('real server records a voice-only Take without Song, backing or timing calibration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-voice-only-'));
  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });
  const mic = await RelayClient.connect(server, '?participant=participant-a&name=A');
  try {
    mic.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
    await mic.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    feedMic(mic, 30);
    await sleep(30);
    mic.send({ type: 'product-status-request' });
    const product = await mic.waitFor((message) => (
      message.type === 'product-status'
      && message.room?.song?.state === 'empty'
      && message.room?.mic?.state === 'live'
      && message.actions?.canStartTake === true
    ));
    assert.equal(product.lifecycle, 'live');
    assert.equal(product.timing.state, 'idle');

    mic.send({ type: 'start-take' });
    const accepted = await mic.waitFor((message) => (
      message.type === 'take-command-accepted' && message.command === 'start'
    ));
    const takeId = String(accepted.takeId);
    const recording = await mic.waitFor((message) => (
      message.type === 'take-status'
      && message.lifecycle === 'recording'
      && message.take?.takeId === takeId
    ));
    assert.equal(recording.take.song.videoId, null);

    feedMic(mic, 40, 3_000);
    await sleep(180);
    mic.send({ type: 'stop-take', takeId });
    const ready = await mic.waitFor((message) => (
      message.type === 'take-status'
      && message.lifecycle === 'ready'
      && message.take?.takeId === takeId
    ));

    const issueCodes = new Set(ready.take.quality.issues.map((issue: { code: string }) => issue.code));
    for (const code of [
      'backing-unavailable',
      'backing-pcm-gap',
      'backing-starvation',
      'timing-fallback',
      'calibration-stale',
      'alignment-clamped',
      'robot-delta-missing',
    ]) assert.equal(issueCodes.has(code), false, String(code) + ' must not describe an intentional voice-only Take');
    assert.equal(ready.take.song.videoId, null);
    assert.ok(ready.take.artifact.durationMs > 0);
  } finally {
    mic.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
