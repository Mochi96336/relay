import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_AUDIO_PROOF_URL ?? 'http://127.0.0.1:4174/';
const SAMPLE_RATE = 48_000;
const FIXTURE_SECONDS = 8;
const PATTERN_SAMPLES = 128;
const PROOF_WINDOW_SAMPLES = 4_096;

function deterministicSample(index) {
  const phase = (2 * Math.PI * (index % PATTERN_SAMPLES)) / PATTERN_SAMPLES;
  return Math.round(
    5_000 * Math.sin(phase)
    + 2_500 * Math.cos(phase * 3)
    + 1_250 * Math.sin(phase * 7),
  );
}

function writePcm16MonoWav(filePath) {
  const sampleCount = SAMPLE_RATE * FIXTURE_SECONDS;
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
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(deterministicSample(index), 44 + index * 2);
  }
  fs.writeFileSync(filePath, wav);
}

function decodePcm16MonoWav(wav) {
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');

  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        encoding: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = wav.subarray(body, body + size);
      break;
    }
    offset = body + size + (size & 1);
  }

  expect(format).toEqual({
    encoding: 1,
    channels: 1,
    sampleRate: SAMPLE_RATE,
    bitsPerSample: 16,
  });
  expect(data, 'finalized Take should contain a PCM data chunk').not.toBeNull();
  expect(data.length % 2).toBe(0);

  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2);
  }
  return samples;
}

function correlation(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return dot / Math.sqrt(aa * bb);
}

function bestPeriodicMatch(observed) {
  let best = null;
  for (let phase = 0; phase < PATTERN_SAMPLES; phase += 1) {
    const expected = new Int16Array(observed.length);
    let absoluteError = 0;
    for (let index = 0; index < observed.length; index += 1) {
      const value = deterministicSample(phase + index);
      expected[index] = value;
      absoluteError += Math.abs(observed[index] - value);
    }
    const candidate = {
      phase,
      meanAbsoluteError: absoluteError / observed.length,
      correlation: correlation(observed, expected),
    };
    if (!best || candidate.meanAbsoluteError < best.meanAbsoluteError) best = candidate;
  }
  return best;
}

const microphoneFixturePath = path.join(
  os.tmpdir(),
  `relay-browser-audio-proof-${process.pid}.wav`,
);
writePcm16MonoWav(microphoneFixturePath);

const launchOptions = {
  args: [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${microphoneFixturePath}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
  ...(process.env.RELAY_CHROMIUM_PATH
    ? { executablePath: process.env.RELAY_CHROMIUM_PATH }
    : {}),
};

test.use({
  permissions: ['microphone'],
  launchOptions,
});

test.afterAll(() => {
  fs.rmSync(microphoneFixturePath, { force: true });
});

test('real Chromium PCM reaches a finalized Take with the expected sample sequence', async ({ page }) => {
  test.setTimeout(30_000);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

  const browserPrimitives = await page.evaluate(() => ({
    audioContext: Function.prototype.toString.call(window.AudioContext),
    audioWorkletNode: Function.prototype.toString.call(window.AudioWorkletNode),
    getUserMedia: Function.prototype.toString.call(navigator.mediaDevices.getUserMedia),
    webSocket: Function.prototype.toString.call(window.WebSocket),
  }));
  for (const [name, source] of Object.entries(browserPrimitives)) {
    expect(source, `${name} must be the Chromium implementation, not an init-script fake`)
      .toContain('[native code]');
  }

  await page.waitForFunction(() => window.relayRecordingState?.connected === true);
  await page.locator('#start-publisher').click();
  await page.waitForFunction(
    () => window.relayRecordingState?.canStart === true,
    undefined,
    { timeout: 10_000 },
  );

  // Make the mixer transfer function deterministic without bypassing the UI or
  // server command path. At 0 dB, a voice-only Take should preserve the browser
  // PCM apart from the browser/worklet's normal int16 round-trip quantization.
  await page.locator('#mic-gain').evaluate((slider) => {
    slider.value = '0';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(150);

  const record = page.locator('#start-recording');
  await expect(record).toBeVisible();
  await expect(record).toBeEnabled();
  await record.click();
  await page.waitForFunction(() => window.relayRecordingState?.lifecycle === 'recording');

  await page.waitForTimeout(1_000);

  const stop = page.locator('#stop-recording');
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();
  await stop.click();
  await page.waitForFunction(
    () => window.relayTakeStatus?.lifecycle === 'ready'
      && typeof window.relayTakeStatus?.take?.artifact?.url === 'string',
    undefined,
    { timeout: 10_000 },
  );

  const take = await page.evaluate(() => structuredClone(window.relayTakeStatus.take));
  expect(take.artifact.sampleRate).toBe(SAMPLE_RATE);
  expect(take.artifact.channels).toBe(1);
  expect(take.artifact.bitsPerSample).toBe(16);
  expect(take.artifact.sampleCount).toBeGreaterThan(PROOF_WINDOW_SAMPLES);

  const artifactUrl = new URL(take.artifact.url, LIVE_URL).toString();
  const response = await page.request.get(artifactUrl);
  expect(response.ok()).toBe(true);
  const samples = decodePcm16MonoWav(await response.body());
  expect(samples.length).toBe(take.artifact.sampleCount);

  const proofStart = Math.max(0, Math.floor((samples.length - PROOF_WINDOW_SAMPLES) / 2));
  const observed = samples.slice(proofStart, proofStart + PROOF_WINDOW_SAMPLES);
  const best = bestPeriodicMatch(observed);

  console.log(
    `[relay-browser-audio-proof] take=${take.takeId} samples=${samples.length} `
    + `phase=${best.phase} mae=${best.meanAbsoluteError.toFixed(2)} `
    + `correlation=${best.correlation.toFixed(6)}`,
  );

  expect(best.correlation).toBeGreaterThan(0.995);
  expect(best.meanAbsoluteError).toBeLessThan(250);
});
