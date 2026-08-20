import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('recorder readiness uses one replayable fresh ProductStatus authority source', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');

  assert.match(source, /type: 'product-status-request'/);
  assert.match(source, /message\.type === 'product-status'/);
  assert.doesNotMatch(
    source,
    /addEventListener\(['"]relay-product-status['"]/,
    'a second window ProductStatus source can overwrite a newer recorder-socket snapshot',
  );
  assert.match(source, /let productStatusFresh = false/);
  assert.match(source, /let takeStatusFresh = false/);
  assert.match(source, /const authorityFresh = productStatusFresh && takeStatusFresh/);
  assert.match(source, /function resetSocketAuthority\(\)/);
});

test('recorder serializes Start while the first command is awaiting server state', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');

  assert.match(source, /let startCommandPending = false/);
  assert.match(
    source,
    /if \(startCommandPending \|\| !recordingState\(\)\.canStart\) return;/,
  );
  assert.match(source, /startCommandPending = true;/);
  assert.match(source, /if \(message\.command === 'start'\) startCommandPending = false;/);
});

test('recording presentation keeps hidden controls authoritative and Stop on the action edge', async () => {
  const css = await readFile(new URL('../public/recording-ui.css', import.meta.url), 'utf8');
  const liveStatus = await readFile(new URL('../public/live-status.js', import.meta.url), 'utf8');

  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(css, /#stop-recording\[hidden\][\s\S]*display:\s*none !important/);
  assert.match(css, /#stop-recording:not\(\[hidden\]\)/);
  assert.match(
    liveStatus,
    /status\.lifecycle === 'preparing'[\s\S]*selfOwner && mic\.state === 'starting'[\s\S]*voice\.startingYours/,
  );
});

test('silent first Mic PCM arms authoritative Record state within the P0 latency budget', async (t) => {
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
    t.diagnostic(`first PCM send -> authoritative canStartTake: ${firstPcmToArmedMs.toFixed(1)} ms`);

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
