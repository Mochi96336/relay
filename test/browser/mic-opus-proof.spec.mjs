import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { startRelay } from './support/relay-process.mjs';
import { launchChromium } from './support/chromium.mjs';
import { wav } from '../support/take-wav.ts';

async function toneFile(directory, frequency) {
  const bytes = wav(48_000, 48_000 * 30);
  for (let i = 0; i < 48_000 * 30; i++)
    bytes.writeInt16LE(Math.round(500 * Math.sin(i * 2 * Math.PI * frequency / 48_000)), 44 + i * 2);
  const input = path.join(directory, `input-${frequency}.wav`);
  await writeFile(input, bytes);
  return input;
}

function opusEnvironment(directory) {
  const env = { RELAY_MIC_OPUS_TRIAL: '1', RELAY_TAKE_DIR: directory, RELAY_TAKE_MIN_FREE_GIB: '0' };
  const direct = process.env.RELAY_PRODUCTION_AUDIO_PROOF_WEBTRANSPORT === '1';
  if (direct) {
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    execFileSync('openssl', ['req', '-new', '-x509', '-key', key, '-out', cert, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
    Object.assign(env, { RELAY_WEBTRANSPORT_PUBLIC_URL: 'https://127.0.0.1:44339/media',
      RELAY_WEBTRANSPORT_HOST: '127.0.0.1', RELAY_WEBTRANSPORT_PORT: '44339',
      RELAY_WEBTRANSPORT_CERT: cert, RELAY_WEBTRANSPORT_KEY: key, RELAY_WEBTRANSPORT_PIN_CERT: '1' });
  }
  return env;
}

function captureBrowser(input) {
  return launchChromium({ args: ['--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${input}`] });
}

async function micPage(browser, base) {
  const page = await browser.newPage({ permissions: ['microphone'] });
  await page.route('https://www.youtube.com/**', route => route.abort());
  await page.goto(base);
  await page.waitForFunction(() => window.relayRecordingState?.connected === true);
  return page;
}

function takePcm(bytes) {
  let offset = 12;
  while (offset + 8 < bytes.length && bytes.toString('ascii', offset, offset + 4) !== 'data')
    offset += 8 + bytes.readUInt32LE(offset + 4) + (bytes.readUInt32LE(offset + 4) & 1);
  return bytes.subarray(offset + 8);
}

test('production Mic WASM Opus reaches the mixer and a non-silent Take', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-mic-opus-browser-'));
  const input = await toneFile(directory, 440);
  const env = opusEnvironment(directory);
  const direct = process.env.RELAY_PRODUCTION_AUDIO_PROOF_WEBTRANSPORT === '1';
  let relay, browser;
  try {
    relay = await startRelay(env);
    const base = `http://127.0.0.1:${relay.port}`;
    browser = await captureBrowser(input);
    const page = await micPage(browser, base);
    page.on('pageerror', error => console.log('[opus-browser-error]', error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('[opus-browser-console]', message.text()); });
    await page.locator('#start-publisher').click();
    try {
      await page.waitForFunction(() => window.relayRecordingState?.canStart === true, null, { timeout: 22000 });
    } catch (error) {
      console.log('[opus-readiness]', JSON.stringify(await (await fetch(`${base}/statusz`)).json()));
      console.log('[opus-page]', JSON.stringify(await page.evaluate(() => window.relayRecordingState)));
      throw error;
    }
    await expect.poll(async () => {
      const status = await (await fetch(`${base}/statusz`)).json();
      return [status.audio?.captureAndSender?.transport?.codec, status.audio?.micMediaPath];
    }).toEqual(['opus', direct ? 'webtransport' : 'websocket']);
    const status = await (await fetch(`${base}/statusz`)).json();
    expect(status.audio.captureAndSender.transport.codecBitrate).toBe(128000);
    expect(status.audio.micSampleRate).toBe(48000);
    await page.locator('#start-recording').click();
    await page.waitForFunction(() => window.relayRecordingState?.lifecycle === 'recording');
    await page.waitForTimeout(2000);
    await page.locator('#stop-recording').click();
    await page.waitForFunction(() => window.relayRecordingState?.lifecycle === 'ready');
    const artifact = await page.evaluate(() => window.relayRecordingState.take.artifact.url);
    const result = Buffer.from(await (await fetch(new URL(artifact, base))).arrayBuffer());
    const pcm = takePcm(result);
    expect(pcm.length).toBeGreaterThan(48000 * 2);
    let energy = 0, real = 0, imag = 0;
    const start = Math.floor(pcm.length / 4), count = 4096;
    for (let i = 0; i < count; i++) {
      const value = pcm.readInt16LE((start + i) * 2);
      energy += value * value;
      real += value * Math.cos(i * 2 * Math.PI * 440 / 48000);
      imag += value * Math.sin(i * 2 * Math.PI * 440 / 48000);
    }
    expect(Math.sqrt(energy / count)).toBeGreaterThan(100);
    expect(2 * (real * real + imag * imag) / (count * energy)).toBeGreaterThan(0.8);
  } finally {
    await browser?.close();
    await relay?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('two production Opus singers survive B media replacement and remain in the Take', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-duet-opus-browser-'));
  let relay, primary, secondary;
  try {
    relay = await startRelay({ ...opusEnvironment(directory), RELAY_CHOIR: '1' });
    primary = await captureBrowser(await toneFile(directory, 440));
    const a = await micPage(primary, relay.httpUrl());
    await a.locator('#start-publisher').click();
    await a.waitForFunction(() => window.relayRecordingState?.canStart === true);
    secondary = await captureBrowser(await toneFile(directory, 660));
    const b = await micPage(secondary, relay.httpUrl());
    await b.evaluate(() => {
      window.__bRegistrations = 0;
      window.__holdBMedia = false;
      window.addEventListener('relay-choir-media-message', event => {
        if (window.__holdBMedia && event.detail.type === 'choir-media-ready') {
          event.stopImmediatePropagation();
          window.__heldBReady = event.detail;
        }
      }, { capture: true });
      window.addEventListener('relay-choir-media-connection', event => {
        if (event.detail.state === 'registered') window.__bRegistrations++;
      });
    });
    await b.locator('#choir-invite-open').click();
    const status = async () => (await fetch(relay.httpUrl('/statusz'))).json();
    await expect.poll(async () => {
      const s = await status();
      return [s.audio.duetIngress.codec, s.audio.duetSecondary?.recentlyHeard];
    }, { timeout: 15_000 }).toEqual(['opus', true]);
    await a.locator('#start-recording').click();
    await a.waitForFunction(() => window.relayRecordingState?.lifecycle === 'recording');
    await a.waitForTimeout(1_200);
    // Retire only B's physical media socket: its track/context/capture clock
    // survive, and the production claim loop establishes a fresh codec pair.
    await b.evaluate(() => {
      window.__holdBMedia = true;
      window.dispatchEvent(new Event('relay-choir-pause-secondary-media'));
    });
    await b.waitForTimeout(500);
    await b.evaluate(() => {
      window.__holdBMedia = false;
      if (window.__heldBReady) window.dispatchEvent(new CustomEvent('relay-choir-media-message', { detail: window.__heldBReady }));
      window.__heldBReady = null;
    });
    await b.waitForFunction(() => window.__bRegistrations >= 2, null, { timeout: 12_000 });
    await expect.poll(async () => (await status()).audio.duetSecondary?.recentlyHeard).toBe(true);
    await a.waitForTimeout(1_200);
    await a.locator('#stop-recording').click();
    await a.waitForFunction(() => window.relayRecordingState?.lifecycle === 'ready');
    const take = await a.evaluate(() => window.relayRecordingState.take);
    const pcm = takePcm(Buffer.from(await (await fetch(new URL(take.artifact.url, relay.httpUrl()))).arrayBuffer()));
    // Score the last second, after B's replacement has reached the room.
    const first = pcm.length / 2 - 48_000;
    const scores = [];
    for (const frequency of [440, 660]) {
      // Read-head clock trim/slew can move phase over a whole second. Score
      // short windows at the known tone, then average power, so legitimate
      // clock correction cannot cancel a voice in the measurement itself.
      const count = 4096;
      let power = 0, windows = 0;
      for (let offset = 0; offset + count <= 48_000; offset += count) {
        let real = 0, imag = 0;
        for (let i = 0; i < count; i++) {
          const value = pcm.readInt16LE((first + offset + i) * 2);
          real += value * Math.cos(i * 2 * Math.PI * frequency / 48_000);
          imag += value * Math.sin(i * 2 * Math.PI * frequency / 48_000);
        }
        power += (2 * Math.hypot(real, imag) / count) ** 2;
        windows++;
      }
      const amplitude = Math.sqrt(power / windows);
      scores.push({ frequency, amplitude });
      expect(amplitude, `${frequency} Hz singer in the final Take`).toBeGreaterThan(1_000);
    }
    expect(take.quality.evidence.secondaryAudibleSamples).toBeGreaterThan(48_000);
    expect(take.quality.evidence.secondaryGapSamples + take.quality.evidence.secondaryStarvedSamples).toBeGreaterThan(0);
    expect((await status()).audio.duetIngress.rejected['codec-error'] ?? 0).toBe(0);
    console.log('[duet-opus-proof]', JSON.stringify({ scores,
      secondaryAudibleMs: take.quality.evidence.secondaryAudibleMs,
      secondaryGapMs: take.quality.evidence.secondaryGapMs,
      clippedSamples: take.quality.evidence.clippedSamples }));
  } finally {
    await primary?.close(); await secondary?.close(); await relay?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
