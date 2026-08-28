import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test } from '@playwright/test';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STARTUP_TIMEOUT_MS = 20_000;
const SAMPLE_RATE = 48_000;
const CHUNK_MS = 20;
const CHUNK_SAMPLES = Math.round((SAMPLE_RATE * CHUNK_MS) / 1000);
const CAPTURE_GENERATION = 7;
const STARVATION_FAULT_MS = 1_200;
const IOS_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';

function startRelay() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(root, 'src', 'server-entry.ts')],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'test',
        RELAY_TEST_LEGACY_PARTICIPANTS: '1',
        RELAY_TEST_LEGACY_INFRASTRUCTURE: '1',
        RELAY_AUTO_CALIBRATE: '0',
        RELAY_CALIBRATION_VALIDATION: '0',
        RELAY_CALIBRATION_PROBE: '0',
        RELAY_HEARTBEAT_MS: '60000',
        RELAY_LIVE_PREBUFFER_MS: '40',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Relay did not start within ${STARTUP_TIMEOUT_MS} ms.\n${stdout}\n${stderr}`));
    }, STARTUP_TIMEOUT_MS);

    const stop = () => new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      child.once('exit', () => done());
      child.kill();
    });

    const onEarlyExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited early with code ${code}.\n${stdout}\n${stderr}`));
    };
    child.once('exit', onEarlyExit);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.off('exit', onEarlyExit);
      const port = Number(match[1]);
      resolve({
        httpUrl: (pathname = '/') => `http://127.0.0.1:${port}${pathname}`,
        wsUrl: (query = '') => `ws://127.0.0.1:${port}/ws${query}`,
        stop,
      });
    });
  });
}

function encodeMicPacket(pcm, sequence, firstSampleIndex) {
  const packet = Buffer.alloc(24 + pcm.byteLength);
  packet.writeUInt16LE(0x4c52, 0);
  packet.writeUInt8(2, 2);
  packet.writeUInt8(1, 3);
  packet.writeUInt32LE(CAPTURE_GENERATION, 4);
  packet.writeUInt32LE(sequence >>> 0, 8);
  packet.writeUInt32LE(pcm.byteLength / 2, 12);
  packet.writeDoubleLE(firstSampleIndex, 16);
  pcm.copy(packet, 24);
  return packet;
}

function sineChunk(firstSampleIndex, frequencyHz = 997, amplitude = 320) {
  const pcm = Buffer.alloc(CHUNK_SAMPLES * 2);
  for (let index = 0; index < CHUNK_SAMPLES; index += 1) {
    const phase = 2 * Math.PI * frequencyHz * ((firstSampleIndex + index) / SAMPLE_RATE);
    pcm.writeInt16LE(Math.round(Math.sin(phase) * amplitude), index * 2);
  }
  return pcm;
}

function waitForJson(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for Relay message.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
    }

    function onMessage(data, isBinary) {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    }

    socket.on('message', onMessage);
  });
}

async function startDeterministicMic(relay) {
  const socket = new WebSocket(relay.wsUrl('?participant=listener-proof-singer&name=Listener%20Proof%20Singer'));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const registered = waitForJson(
    socket,
    (message) => message.type === 'registered' && message.role === 'publisher',
  );
  socket.send(JSON.stringify({
    type: 'register',
    role: 'publisher',
    sampleRate: SAMPLE_RATE,
    captureGeneration: CAPTURE_GENERATION,
    initialSequence: 0,
    audioPacketVersion: 2,
  }));
  await registered;

  let sequence = 0;
  let sampleCursor = 0;
  function sendChunk() {
    if (socket.readyState !== WebSocket.OPEN) return;
    const pcm = sineChunk(sampleCursor);
    socket.send(encodeMicPacket(pcm, sequence, sampleCursor));
    sequence = (sequence + 1) >>> 0;
    sampleCursor += CHUNK_SAMPLES;
  }

  // Prime immediately, then preserve approximately realtime capture cadence so
  // this proof exercises the same queueing assumptions as an actual handset.
  sendChunk();
  const timer = setInterval(sendChunk, CHUNK_MS);
  return {
    close() {
      clearInterval(timer);
      try { socket.close(); } catch {}
    },
  };
}

async function latestHealthObservedAt(page) {
  return page.evaluate(() => Number(window.relayListenHealth?.observedAt ?? -1));
}

async function waitForHealthyPlayback(page, { afterObservedAt = -1, timeout = 8_000 } = {}) {
  await page.waitForFunction((after) => {
    const state = window.relayListenState;
    const health = window.relayListenHealth;
    const observedAt = Number(health?.observedAt);
    return state?.audioReady === true
      && state?.muted === false
      && health?.playing === true
      && Number.isFinite(observedAt)
      && observedAt > after;
  }, afterObservedAt, { timeout });
}

async function openListener(page, relay, { debug = false } = {}) {
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(relay.httpUrl(debug ? '/?audioDebug=1' : '/'), { waitUntil: 'domcontentloaded' });
  await page.locator('body').click({ position: { x: 12, y: 12 } });
  await waitForHealthyPlayback(page);
}

test('real Chromium renders the real Relay monitor path through production Listen', async () => {
  test.setTimeout(35_000);
  const relay = await startRelay();
  const mic = await startDeterministicMic(relay);
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  try {
    await openListener(page, relay);

    const primitives = await page.evaluate(() => ({
      audioContext: Function.prototype.toString.call(window.AudioContext),
      audioWorkletNode: Function.prototype.toString.call(window.AudioWorkletNode),
      webSocket: Function.prototype.toString.call(window.WebSocket),
      state: window.relayListenState,
      health: window.relayListenHealth,
    }));
    for (const name of ['audioContext', 'audioWorkletNode', 'webSocket']) {
      expect(primitives[name], `${name} must remain Chromium-native`).toContain('[native code]');
    }
    assert.equal(primitives.state.audioReady, true);
    assert.equal(primitives.state.muted, false);
    assert.equal(primitives.health.playing, true);
    assert.ok(Number(primitives.health.queuedMs) >= 0);
    assert.ok(Number(primitives.health.starvedMs) >= 0);
  } finally {
    await browser.close();
    mic.close();
    await relay.stop();
  }
});

test('real Chromium listener recovers monitor reconnect, proven starvation and AudioContext interruption', async () => {
  test.setTimeout(45_000);
  const relay = await startRelay();
  const mic = await startDeterministicMic(relay);
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  try {
    await openListener(page, relay, { debug: true });
    await page.waitForFunction(() => window.__relayListenerDiagnostics?.snapshot?.()?.evidence === 'internally-healthy');

    let beforeHealth = await latestHealthObservedAt(page);
    const firstConnectionCount = await page.evaluate(
      () => window.__relayListenerDiagnostics.snapshot().monitorConnectionCount,
    );
    await page.evaluate(() => window.__relayListenerDiagnostics.faults.disconnectMonitor());
    await page.waitForFunction((before) => (
      window.__relayListenerDiagnostics.snapshot().monitorConnectionCount > before
    ), firstConnectionCount, { timeout: 4_000 });
    await waitForHealthyPlayback(page, { afterObservedAt: beforeHealth });

    const starvationBefore = await page.evaluate(() => ({
      observedAt: Number(window.relayListenHealth?.observedAt ?? -1),
      underruns: Number(window.relayListenHealth?.underruns ?? 0),
      starvedMs: Number(window.relayListenHealth?.starvedMs ?? 0),
    }));
    await page.evaluate((durationMs) => window.__relayListenerDiagnostics.faults.dropPcm(durationMs), STARVATION_FAULT_MS);
    await page.waitForFunction(() => (
      window.__relayListenerDiagnostics.dump().events.some((entry) => entry.type === 'fault-pcm-dropped')
    ));
    await page.waitForFunction((before) => {
      const health = window.relayListenHealth;
      return Number(health?.observedAt) > before.observedAt
        && (
          Number(health?.underruns ?? 0) > before.underruns
          || Number(health?.starvedMs ?? 0) > before.starvedMs
        );
    }, starvationBefore, { timeout: STARVATION_FAULT_MS + 3_000 });
    beforeHealth = await latestHealthObservedAt(page);
    await page.waitForFunction(() => window.__relayListenerDiagnostics.faults.state().dropPcm === false, null, {
      timeout: STARVATION_FAULT_MS + 1_000,
    });
    await waitForHealthyPlayback(page, { afterObservedAt: beforeHealth });

    beforeHealth = await latestHealthObservedAt(page);
    const connectionCountBeforeInterruption = await page.evaluate(
      () => window.__relayListenerDiagnostics.snapshot().monitorConnectionCount,
    );
    await page.evaluate(() => window.__relayListenerDiagnostics.faults.interruptAudio(250));
    await page.waitForFunction(
      () => window.__relayListenerDiagnostics.snapshot().contextState !== 'running',
      null,
      { timeout: 1_000 },
    );
    await page.waitForFunction(
      () => window.__relayListenerDiagnostics.snapshot().contextState === 'running',
      null,
      { timeout: 2_500 },
    );
    await page.waitForFunction((before) => (
      window.__relayListenerDiagnostics.snapshot().monitorConnectionCount > before
    ), connectionCountBeforeInterruption, { timeout: 4_000 });
    await waitForHealthyPlayback(page, { afterObservedAt: beforeHealth });

    const dump = await page.evaluate(() => {
      window.__relayListenerDiagnostics.snapshot();
      return window.__relayListenerDiagnostics.dump();
    });
    const eventTypes = dump.events.map((entry) => entry.type);
    expect(eventTypes).toContain('fault-monitor-disconnect');
    expect(eventTypes).toContain('fault-pcm-drop-start');
    expect(eventTypes).toContain('fault-pcm-dropped');
    expect(eventTypes).toContain('fault-audio-interrupt-start');
    expect(eventTypes).toContain('fault-audio-interrupt-release');
    expect(dump.snapshots.at(-1)?.evidence).toBe('internally-healthy');
  } finally {
    await browser.close();
    mic.close();
    await relay.stop();
  }
});

test('iOS foreground lifecycle restarts the real AudioDestination once and returns to healthy playback', async () => {
  test.setTimeout(45_000);
  const relay = await startRelay();
  const mic = await startDeterministicMic(relay);
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: IOS_USER_AGENT,
  });
  const page = await context.newPage();

  try {
    await openListener(page, relay, { debug: true });
    await page.waitForFunction(() => window.__relayListenerDiagnostics?.snapshot?.()?.evidence === 'internally-healthy');
    assert.match(await page.evaluate(() => navigator.userAgent), /iPhone/);
    const beforeHealth = await latestHealthObservedAt(page);
    const eventStart = await page.evaluate(() => window.__relayListenerDiagnostics.dump().events.length);

    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForFunction((start) => {
      const events = window.__relayListenerDiagnostics.dump().events.slice(start);
      const suspendAt = events.findIndex((entry) => (
        entry.type === 'audio-context-suspend-request' && entry.detail?.listener === true
      ));
      if (suspendAt < 0) return false;
      const settled = events.some((entry, index) => (
        index > suspendAt
        && entry.type === 'audio-context-suspend-settled'
        && entry.detail?.listener === true
      ));
      const resumed = events.some((entry, index) => (
        index > suspendAt
        && entry.type === 'audio-context-resume-request'
        && entry.detail?.listener === true
      ));
      return settled && resumed;
    }, eventStart, { timeout: 4_000 });
    await waitForHealthyPlayback(page, { afterObservedAt: beforeHealth });

    const firstKickCount = await page.evaluate((start) => (
      window.__relayListenerDiagnostics.dump().events.slice(start).filter((entry) => (
        entry.type === 'audio-context-suspend-request' && entry.detail?.listener === true
      )).length
    ), eventStart);
    assert.equal(firstKickCount, 1, 'one foreground boundary must request one destination stop/start');

    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForTimeout(500);
    const duplicateKickCount = await page.evaluate((start) => (
      window.__relayListenerDiagnostics.dump().events.slice(start).filter((entry) => (
        entry.type === 'audio-context-suspend-request' && entry.detail?.listener === true
      )).length
    ), eventStart);
    assert.equal(duplicateKickCount, 1, 'duplicate pageshow for the same foreground boundary must be idempotent');
    await waitForHealthyPlayback(page);
  } finally {
    await browser.close();
    mic.close();
    await relay.stop();
  }
});

test('iOS lifecycle waits through slow foreground resume and delayed post-Mic ownership', async () => {
  test.setTimeout(45_000);
  const relay = await startRelay();
  const mic = await startDeterministicMic(relay);
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: IOS_USER_AGENT,
  });
  const page = await context.newPage();

  const waitForDestinationRestart = async (eventStart) => {
    await page.waitForFunction((start) => {
      const events = window.__relayListenerDiagnostics.dump().events.slice(start);
      const suspendAt = events.findIndex((entry) => (
        entry.type === 'audio-context-suspend-request' && entry.detail?.listener === true
      ));
      if (suspendAt < 0) return false;
      const settled = events.some((entry, index) => (
        index > suspendAt
        && entry.type === 'audio-context-suspend-settled'
        && entry.detail?.listener === true
      ));
      const resumed = events.some((entry, index) => (
        index > suspendAt
        && entry.type === 'audio-context-resume-request'
        && entry.detail?.listener === true
      ));
      return settled && resumed;
    }, eventStart, { timeout: 4_000 });
  };

  try {
    await openListener(page, relay, { debug: true });
    await page.waitForFunction(() => window.__relayListenerDiagnostics?.snapshot?.()?.evidence === 'internally-healthy');

    await page.evaluate(() => window.__relayListenerDiagnostics.faults.interruptAudio(350));
    const slowForegroundStart = await page.evaluate(() => window.__relayListenerDiagnostics.dump().events.length);
    const healthBeforeForeground = await latestHealthObservedAt(page);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await page.waitForTimeout(175);
    const earlyForegroundKicks = await page.evaluate((start) => (
      window.__relayListenerDiagnostics.dump().events.slice(start).filter((entry) => (
        entry.type === 'audio-context-suspend-request' && entry.detail?.listener === true
      )).length
    ), slowForegroundStart);
    assert.equal(earlyForegroundKicks, 0,
      'the destination kick must wait while foreground resume is still blocked past 100 ms');
    await waitForDestinationRestart(slowForegroundStart);
    await waitForHealthyPlayback(page, { afterObservedAt: healthBeforeForeground });

    const participantId = await page.evaluate(() => window.relayParticipantId ?? null);
    assert.equal(typeof participantId, 'string');
    assert.ok(participantId.length > 0);
    await page.evaluate((ownerId) => {
      window.dispatchEvent(new CustomEvent('relay-session-status', {
        detail: { micOwnerId: ownerId },
      }));
    }, participantId);
    await page.waitForFunction(() => window.relayListenState?.muted === true);

    const postMicStart = await page.evaluate(() => window.__relayListenerDiagnostics.dump().events.length);
    const healthBeforePostMic = await latestHealthObservedAt(page);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('relay-microphone-ended', {
        detail: { reason: 'proof-delayed-owner' },
      }));
    });
    await page.waitForTimeout(250);
    const earlyPostMicKicks = await page.evaluate((start) => (
      window.__relayListenerDiagnostics.dump().events.slice(start).filter((entry) => (
        entry.type === 'audio-context-suspend-request' && entry.detail?.listener === true
      )).length
    ), postMicStart);
    assert.equal(earlyPostMicKicks, 0,
      'post-Mic recovery must not touch AudioDestination while room ownership is still muted');

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('relay-session-status', {
        detail: { micOwnerId: null },
      }));
    });
    await waitForDestinationRestart(postMicStart);
    await waitForHealthyPlayback(page, { afterObservedAt: healthBeforePostMic });
  } finally {
    await browser.close();
    mic.close();
    await relay.stop();
  }
});
