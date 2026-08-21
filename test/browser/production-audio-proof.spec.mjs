import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_MIC_GAIN_DB = 24;
const LEVELS = [1 / 256, -1 / 128, 3 / 256];
const SEGMENT_MS = 180;
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
        RELAY_AUTO_CALIBRATE: '0',
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

function expectedMixedSample(level) {
  const captured = level < 0
    ? Math.trunc(level * 0x8000)
    : Math.trunc(level * 0x7fff);
  const gain = 10 ** (DEFAULT_MIC_GAIN_DB / 20);
  const mixed = (captured / 0x8000) * gain;
  assert.ok(Math.abs(mixed) < 0.5, 'proof levels must stay comfortably below the limiter');
  return Math.round(mixed * (mixed < 0 ? 0x8000 : 0x7fff));
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

test('real Chromium PCM survives production capture, transport, mixer and Take WAV', async ({ page }) => {
  test.setTimeout(30_000);
  const takeDir = await mkdtemp(path.join(os.tmpdir(), 'relay-production-browser-audio-'));
  const relay = await startRelay(takeDir);

  try {
    // Only the physical microphone is replaced. The stream itself is generated
    // by real Web Audio, and Relay still creates its production AudioContext,
    // loads capture-worklet.js, frames AudioPacket v2, and sends it through the
    // production browser transport to the real server.
    await page.addInitScript(() => {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices) throw new Error('Chromium mediaDevices is unavailable.');

      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
          const destination = context.createMediaStreamDestination();
          const source = context.createConstantSource();
          source.offset.value = 0;
          source.connect(destination);
          source.start();
          await context.resume();

          window.__relayProductionAudioProof = {
            sampleRate: context.sampleRate,
            emit(levels, segmentMs) {
              const now = context.currentTime;
              const start = now + 0.05;
              source.offset.cancelScheduledValues(now);
              source.offset.setValueAtTime(0, now);
              levels.forEach((level, index) => {
                source.offset.setValueAtTime(level, start + (index * segmentMs) / 1000);
              });
              const end = start + (levels.length * segmentMs) / 1000;
              source.offset.setValueAtTime(0, end);
              return { start, end, sampleRate: context.sampleRate };
            },
          };

          return destination.stream;
        },
      });
    });

    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.goto(relay.httpUrl('/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.relayRecordingState?.connected === true);

    await page.locator('#start-publisher').click();
    await page.waitForFunction(() => window.relayRecordingState?.canStart === true, null, { timeout: 10_000 });
    await expect(page.locator('#start-recording')).toBeEnabled();

    await page.locator('#start-recording').click();
    await page.waitForFunction(() => window.relayRecordingState?.lifecycle === 'recording');
    const takeId = await page.evaluate(() => window.relayRecordingState?.take?.takeId ?? null);
    assert.ok(takeId, 'production Record action must yield a real Take id');

    const emission = await page.evaluate(
      ({ levels, segmentMs }) => window.__relayProductionAudioProof.emit(levels, segmentMs),
      { levels: LEVELS, segmentMs: SEGMENT_MS },
    );
    assert.ok(emission.sampleRate >= 8_000, 'deterministic source must run in a real AudioContext');

    await page.waitForTimeout(LEVELS.length * SEGMENT_MS + 350);
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

    const expected = LEVELS.map(expectedMixedSample);
    const plateaus = [];
    let cursor = 0;
    for (const target of expected) {
      const plateau = findPlateau(samples, target, cursor);
      plateaus.push({ target, ...plateau });
      cursor = plateau.end;
    }

    console.log(`[relay-production-audio-proof] ${JSON.stringify({
      takeId,
      sourceSampleRate: emission.sampleRate,
      wavSamples: samples.length,
      expected,
      plateaus,
    })}`);
  } finally {
    await relay.stop();
    await rm(takeDir, { recursive: true, force: true });
  }
});
