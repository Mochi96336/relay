import { spawn } from 'node:child_process';
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

function startRelay(takeDir) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(root, 'src', 'server-entry.ts')],
    {
      cwd: root,
      env: {
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

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited early with code ${code}.\n${stdout}\n${stderr}`));
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/localhost:(\d+)/);
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

  for (let index = startAt; index < samples.length; index += 1) {
    if (Math.abs(samples[index] - target) <= 2) {
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
    `Expected at least ${MIN_PLATEAU_SAMPLES} consecutive samples near ${target}; `
    + `searched ${samples.length - startAt} samples from offset ${startAt}.`,
  );
}

test('real Chromium PCM survives production capture, transport, mixer and Take WAV', async () => {
  test.setTimeout(30_000);
  const takeDir = await mkdtemp(path.join(os.tmpdir(), 'relay-production-browser-audio-'));
  const capturePath = path.join(takeDir, 'deterministic-browser-mic.wav');
  await writeFile(capturePath, deterministicCaptureWav());
  const relay = await startRelay(takeDir);
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

    await page.locator('#start-publisher').click();
    await page.waitForFunction(() => window.relayRecordingState?.canStart === true, null, { timeout: 5_000 });
    await expect(page.locator('#start-recording')).toBeEnabled();

    await page.locator('#start-recording').click();
    await page.waitForFunction(() => window.relayRecordingState?.lifecycle === 'recording');
    const takeId = await page.evaluate(() => window.relayRecordingState?.take?.takeId ?? null);
    assert.ok(takeId, 'production Record action must yield a real Take id');

    // The capture file began when getUserMedia opened. Its long silent lead-in
    // gives the production server time to establish Mic readiness and arm Record;
    // keep recording through all three deterministic plateaus and trailing zero.
    await page.waitForTimeout(LEAD_MS + INPUT_LEVELS.length * SEGMENT_MS + 500);
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

    console.log(`[relay-production-audio-proof] ${JSON.stringify({
      takeId,
      inputSampleRate: SAMPLE_RATE,
      inputSamples: INPUT_LEVELS,
      wavSamples: samples.length,
      expected,
      plateaus,
    })}`);
  } finally {
    await browser.close();
    await relay.stop();
    await rm(takeDir, { recursive: true, force: true });
  }
});
