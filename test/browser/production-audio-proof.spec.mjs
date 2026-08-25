import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STARTUP_TIMEOUT_MS = 20_000;
const SAMPLE_RATE = 48_000;
const DEFAULT_MIC_GAIN_DB = 24;
const INPUT_LEVELS = [-256, -512, -768];
const LEAD_MS = 4_000;
const SEGMENT_MS = 350;
const TRAIL_MS = 1_000;
const MIN_PLATEAU_SAMPLES = 256;
const MIXED_SAMPLE_TOLERANCE = Math.ceil(10 ** (DEFAULT_MIC_GAIN_DB / 20)) + 2;
const REQUIRE_WEBTRANSPORT = process.env.RELAY_PRODUCTION_AUDIO_PROOF_WEBTRANSPORT === '1';
const WEBTRANSPORT_PORT = 44_338;
const WEBTRANSPORT_ENV_NAMES = [
  'RELAY_WEBTRANSPORT_PUBLIC_URL',
  'RELAY_WEBTRANSPORT_HOST',
  'RELAY_WEBTRANSPORT_PORT',
  'RELAY_WEBTRANSPORT_CERT',
  'RELAY_WEBTRANSPORT_KEY',
  'RELAY_WEBTRANSPORT_PIN_CERT',
];

function pinnedWebTransportEnv(directory) {
  const keyPath = path.join(directory, 'webtransport-key.pem');
  const certPath = path.join(directory, 'webtransport-cert.pem');
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
  execFileSync('openssl', [
    'req', '-new', '-x509',
    '-key', keyPath,
    '-out', certPath,
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  return {
    RELAY_WEBTRANSPORT_PUBLIC_URL: `https://127.0.0.1:${WEBTRANSPORT_PORT}/media`,
    RELAY_WEBTRANSPORT_HOST: '127.0.0.1',
    RELAY_WEBTRANSPORT_PORT: String(WEBTRANSPORT_PORT),
    RELAY_WEBTRANSPORT_CERT: certPath,
    RELAY_WEBTRANSPORT_KEY: keyPath,
    RELAY_WEBTRANSPORT_PIN_CERT: '1',
  };
}

function startRelay(takeDir, directMediaEnv = {}) {
  const env = {
    ...process.env,
    PORT: '0',
    NODE_ENV: 'test',
    RELAY_TAKE_DIR: takeDir,
    RELAY_TAKE_MIN_FREE_GIB: '0',
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_VALIDATION: '0',
    RELAY_CALIBRATION_PROBE: '0',
    RELAY_HEARTBEAT_MS: '60000',
    RELAY_LIVE_PREBUFFER_MS: '40',
  };
  for (const name of WEBTRANSPORT_ENV_NAMES) delete env[name];
  Object.assign(env, directMediaEnv);

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(root, 'src', 'server-entry.ts')],
    {
      cwd: root,
      env,
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

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited early with code ${code}.\n${stdout}\n${stderr}`));
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/localhost:(\d+)/i);
      if (!match) return;

      clearTimeout(timer);
      child.removeAllListeners('exit');
      const port = Number(match[1]);
      resolve({
        httpUrl: (pathname = '/') => `http://127.0.0.1:${port}${pathname}`,
        stop,
      });
    });
  });
}

function pcm16Wav(segments) {
  const sampleCount = segments.reduce((total, segment) => (
    total + Math.round((segment.durationMs * SAMPLE_RATE) / 1000)
  ), 0);
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);

  let sampleOffset = 44;
  for (const segment of segments) {
    const count = Math.round((segment.durationMs * SAMPLE_RATE) / 1000);
    for (let index = 0; index < count; index += 1) {
      wav.writeInt16LE(segment.value, sampleOffset);
      sampleOffset += 2;
    }
  }
  return wav;
}

function deterministicCaptureWav() {
  return pcm16Wav([
    { value: 0, durationMs: LEAD_MS },
    ...INPUT_LEVELS.map((value) => ({ value, durationMs: SEGMENT_MS })),
    { value: 0, durationMs: TRAIL_MS },
  ]);
}

function wavPcm16(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === 'data') {
      assert.equal(size % 2, 0, 'PCM16 data chunk must contain whole samples');
      const samples = new Int16Array(size / 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = buffer.readInt16LE(dataStart + index * 2);
      }
      return samples;
    }
    offset = dataStart + size + (size % 2);
  }

  throw new Error('Finalized Take WAV has no data chunk.');
}

function expectedMixedSample(inputSample) {
  const gain = 10 ** (DEFAULT_MIC_GAIN_DB / 20);
  const mixed = (inputSample / 0x8000) * gain;
  assert.ok(Math.abs(mixed) < 0.5, 'proof levels must stay comfortably below the limiter');
  return Math.round(mixed * 0x8000);
}

function findPlateau(samples, target, startAt) {
  let runStart = -1;
  let runLength = 0;

  // Chromium's native media pipeline may quantize the WAV-backed fake device
  // by one input PCM16 LSB before WebAudio sees it. The production +24 dB mic
  // gain magnifies that one input LSB to about 16 Take-sample LSBs. Permit only
  // that bounded native-capture quantization plus output rounding; do not learn
  // a runner-specific scale from the produced WAV.
  for (let index = startAt; index < samples.length; index += 1) {
    if (Math.abs(samples[index] - target) <= MIXED_SAMPLE_TOLERANCE) {
      if (runLength === 0) runStart = index;
      runLength += 1;
      if (runLength >= MIN_PLATEAU_SAMPLES) {
        return { start: runStart, end: index + 1, length: runLength };
      }
      continue;
    }
    runStart = -1;
    runLength = 0;
  }

  throw new Error(
    `Expected at least ${MIN_PLATEAU_SAMPLES} consecutive samples near ${target} `
    + `(±${MIXED_SAMPLE_TOLERANCE}); searched ${samples.length - startAt} samples from offset ${startAt}.`,
  );
}

async function printReadinessDiagnostics(page, relay) {
  const browserState = await page.evaluate(() => ({
    recording: window.relayRecordingState ?? null,
    take: window.relayTakeStatus ?? null,
    micAction: window.relayMicActionState ?? null,
    activeRole: window.relayActiveRole ?? null,
    proof: window.__relayAudioProofDiagnostics ?? null,
    status: document.querySelector('#status')?.textContent ?? null,
    details: document.querySelector('#details')?.textContent ?? null,
    publisherDisabled: document.querySelector('#start-publisher')?.disabled ?? null,
    recordDisabled: document.querySelector('#start-recording')?.disabled ?? null,
  }));
  let readyz;
  try {
    const response = await fetch(relay.httpUrl('/readyz'));
    readyz = { status: response.status, body: await response.json() };
  } catch (error) {
    readyz = { error: error instanceof Error ? error.message : String(error) };
  }
  console.log(`[relay-production-audio-readiness] ${JSON.stringify({ browserState, readyz })}`);
}

async function readTransportStatus(relay) {
  const response = await fetch(relay.httpUrl('/statusz'), { cache: 'no-store' });
  assert.equal(response.status, 200, `statusz request failed with ${response.status}`);
  return response.json();
}

async function waitForWebTransportProof(relay, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readTransportStatus(relay);
    const sender = latest?.audio?.captureAndSender?.transport;
    if (
      latest?.audio?.micMediaPath === 'webtransport'
      && sender?.path === 'webtransport'
      && sender?.webTransportConnections >= 1
      && sender?.webTransportPacketsSubmitted > 0
    ) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chromium never proved an active WebTransport media path: ${JSON.stringify(latest)}`);
}

function assertNoWebSocketAudioFallback(statusPayload) {
  const sender = statusPayload?.audio?.captureAndSender?.transport;
  assert.equal(statusPayload?.audio?.micMediaPath, 'webtransport');
  assert.equal(sender?.path, 'webtransport');
  assert.ok(sender?.webTransportConnections >= 1, 'browser must establish a native WebTransport session');
  assert.ok(sender?.webTransportPacketsSubmitted > 0, 'browser must submit microphone datagrams');
  assert.equal(sender?.webTransportDemotions, 0, 'WebTransport must remain selected for the proof');
  assert.equal(sender?.webSocketPacketsSent, 0, 'no microphone packet may use WebSocket fallback');
  assert.equal(sender?.webSocketCongestedRejects, 0, 'WebSocket fallback must remain unused');
  assert.equal(sender?.webSocketDisconnectedRejects, 0, 'WebSocket fallback must remain unused');
  assert.equal(sender?.webSocketSendFailures, 0, 'WebSocket fallback must remain unused');
}

const proofName = REQUIRE_WEBTRANSPORT
  ? 'real Chromium PCM survives native WebTransport, mixer and Take WAV'
  : 'real Chromium PCM survives production capture, transport, mixer and Take WAV';

test(proofName, async () => {
  test.setTimeout(45_000);
  const takeDir = await mkdtemp(path.join(os.tmpdir(), 'relay-production-browser-audio-'));
  const capturePath = path.join(takeDir, 'deterministic-browser-mic.wav');
  await writeFile(capturePath, deterministicCaptureWav());
  const directMediaEnv = REQUIRE_WEBTRANSPORT ? pinnedWebTransportEnv(takeDir) : {};
  const relay = await startRelay(takeDir, directMediaEnv);
  const browser = await chromium.launch({
    // Playwright's default headless executable is chromium-headless-shell.
    // The production proof intentionally uses full Chromium's new headless mode
    // so Web Audio/media-device behaviour matches a real browser process.
    channel: 'chromium',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${capturePath}`,
    ],
  });
  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  try {
    // Chromium supplies deterministic PCM as its microphone device. Everything
    // after getUserMedia is production code: Relay creates the real AudioContext,
    // loads capture-worklet.js, frames AudioPacket v2, chooses its production
    // transport, feeds the real server mixer, and finalizes the Take writer.
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.goto(relay.httpUrl('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.relayRecordingState?.connected === true);

    const browserPrimitives = await page.evaluate(() => ({
      audioContext: Function.prototype.toString.call(window.AudioContext),
      audioWorkletNode: Function.prototype.toString.call(window.AudioWorkletNode),
      getUserMedia: Function.prototype.toString.call(navigator.mediaDevices.getUserMedia),
      webSocket: Function.prototype.toString.call(window.WebSocket),
      webTransport: typeof window.WebTransport === 'function'
        ? Function.prototype.toString.call(window.WebTransport)
        : null,
    }));
    for (const [name, source] of Object.entries(browserPrimitives)) {
      if (name === 'webTransport' && !REQUIRE_WEBTRANSPORT) continue;
      expect(source, `${name} must remain Chromium-native`).toContain('[native code]');
    }

    await page.evaluate(() => {
      window.__relayAudioProofDiagnostics = {
        microphoneStarted: 0,
        microphoneFailed: null,
        localMicLevelEvents: 0,
        lastLocalMicLevel: null,
      };
      window.addEventListener('relay-microphone-started', () => {
        window.__relayAudioProofDiagnostics.microphoneStarted += 1;
      });
      window.addEventListener('relay-microphone-start-failed', (event) => {
        window.__relayAudioProofDiagnostics.microphoneFailed = event.detail ?? true;
      });
      window.addEventListener('relay-local-mic-level', (event) => {
        if (event.detail?.active !== true) return;
        window.__relayAudioProofDiagnostics.localMicLevelEvents += 1;
        window.__relayAudioProofDiagnostics.lastLocalMicLevel = event.detail;
      });
    });

    await page.locator('#start-publisher').click();
    try {
      await page.waitForFunction(
        () => window.relayRecordingState?.canStart === true,
        null,
        { timeout: 22_000 },
      );
    } catch (error) {
      await printReadinessDiagnostics(page, relay);
      throw error;
    }
    await expect(page.locator('#start-recording')).toBeEnabled();

    await page.locator('#start-recording').click();
    await page.waitForFunction(() => window.relayRecordingState?.lifecycle === 'recording');
    const takeId = await page.evaluate(() => window.relayRecordingState?.take?.takeId ?? null);
    assert.ok(takeId, 'production Record action must yield a real Take id');

    // The capture file began when getUserMedia opened. Its long silent lead-in
    // gives the production server time to establish Mic readiness and arm Record;
    // keep recording through all three deterministic plateaus and trailing zero.
    await page.waitForTimeout(LEAD_MS + INPUT_LEVELS.length * SEGMENT_MS + 500);

    let transportProof = null;
    if (REQUIRE_WEBTRANSPORT) {
      transportProof = await waitForWebTransportProof(relay);
      assertNoWebSocketAudioFallback(transportProof);
    }

    await page.locator('#stop-recording').click();
    await page.waitForFunction(
      (id) => window.relayRecordingState?.lifecycle === 'ready'
        && window.relayRecordingState?.take?.takeId === id,
      takeId,
      { timeout: 10_000 },
    );

    const artifactUrl = await page.evaluate(() => window.relayRecordingState?.take?.artifact?.url ?? null);
    assert.ok(artifactUrl, 'finalized Take must expose its WAV artifact');

    const response = await fetch(relay.httpUrl(artifactUrl));
    assert.equal(response.status, 200, `Take WAV request failed with ${response.status}`);
    const samples = wavPcm16(Buffer.from(await response.arrayBuffer()));
    assert.ok(samples.length > 0, 'Take WAV must contain PCM samples');

    const expected = INPUT_LEVELS.map(expectedMixedSample);
    const plateaus = [];
    let cursor = 0;
    for (const target of expected) {
      const plateau = findPlateau(samples, target, cursor);
      plateaus.push({ target, ...plateau });
      cursor = plateau.end;
    }

    const senderTransport = transportProof?.audio?.captureAndSender?.transport ?? null;
    console.log(`[relay-production-audio-proof] ${JSON.stringify({
      takeId,
      requiredTransport: REQUIRE_WEBTRANSPORT ? 'webtransport' : 'production-default',
      negotiatedTransport: senderTransport?.path ?? null,
      webTransportConnections: senderTransport?.webTransportConnections ?? null,
      webTransportPacketsSubmitted: senderTransport?.webTransportPacketsSubmitted ?? null,
      webSocketPacketsSent: senderTransport?.webSocketPacketsSent ?? null,
      inputSampleRate: SAMPLE_RATE,
      inputSamples: INPUT_LEVELS,
      wavSamples: samples.length,
      expected,
      tolerance: MIXED_SAMPLE_TOLERANCE,
      plateaus,
    })}`);
  } finally {
    await browser.close();
    await relay.stop();
    await rm(takeDir, { recursive: true, force: true });
  }
});
