import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { RelayClient, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

function silentPcm(ms: number) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

test('silent first Mic PCM arms authoritative Record state within the P0 latency budget', async () => {
  const server = await startRelay(FAST);
  try {
    const singer = await RelayClient.connect(
      server,
      '?participant=p0-singer-123&name=P0%20Singer',
    );
    singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await singer.waitForType('registered');

    const recorder = await RelayClient.connect(
      server,
      '?participant=p0-recorder-123&name=P0%20Recorder',
    );
    recorder.send({ type: 'product-status-request' });
    const starting = await recorder.waitFor(
      (message) => message.type === 'product-status'
        && message.room?.mic?.ownerId === 'p0-singer-123'
        && message.room?.mic?.state === 'starting',
    );
    assert.equal(starting.actions.canStartTake, false);

    // Zero-filled PCM is intentionally used here: streaming means fresh real
    // capture frames, not audible singing or a level threshold.
    const beforeFirstPcm = performance.now();
    singer.sendPcm(silentPcm(20));

    const armed = await recorder.waitFor(
      (message) => message.type === 'product-status'
        && message.room?.mic?.ownerId === 'p0-singer-123'
        && message.room?.mic?.state === 'live'
        && message.actions?.canStartTake === true,
      1_000,
    );
    const firstPcmToArmedMs = performance.now() - beforeFirstPcm;

    assert.equal(armed.lifecycle, 'live');
    assert.equal(armed.actions.startTakeBlockedReason, null);
    assert.ok(
      firstPcmToArmedMs < 350,
      `first PCM -> authoritative Record arm took ${firstPcmToArmedMs.toFixed(1)} ms`,
    );

    singer.close();
    recorder.close();
  } finally {
    await server.stop();
  }
});
