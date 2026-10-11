import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';

test('production Mic WASM Opus reaches the mixer and a non-silent Take', async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-mic-opus-browser-'));
  const wav = Buffer.alloc(44 + 48000 * 30 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000 * 30; i++) wav.writeInt16LE(Math.round(500 * Math.sin(i * 2 * Math.PI * 440 / 48000)), 44 + i * 2);
  const input = path.join(directory, 'input.wav');
  await writeFile(input, wav);
  const env = { ...process.env, PORT: '0', RELAY_MIC_OPUS_TRIAL: '1', RELAY_TAKE_DIR: directory,
    RELAY_TAKE_MIN_FREE_GIB: '0', RELAY_AUTO_CALIBRATE: '0', RELAY_CALIBRATION_PROBE: '0',
    RELAY_CALIBRATION_VALIDATION: '0', RELAY_HEARTBEAT_MS: '60000' };
  for (const key of Object.keys(env)) if (key.startsWith('RELAY_WEBTRANSPORT_')) delete env[key];
  delete env.RELAY_KEY;
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
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server-entry.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', browser;
  child.stderr.on('data', data => { logs += data; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${logs}`)), 20000);
      child.stdout.on('data', data => {
        logs += data;
        const match = logs.match(/listening on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
    });
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ channel: 'chromium', ...(process.env.RELAY_BROWSER_EXECUTABLE
      ? { executablePath: process.env.RELAY_BROWSER_EXECUTABLE } : {}), args: ['--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${input}`] });
    const page = await browser.newPage({ permissions: ['microphone'] });
    page.on('pageerror', error => console.log('[opus-browser-error]', error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('[opus-browser-console]', message.text()); });
    await page.route('https://www.youtube.com/**', route => route.abort());
    await page.goto(base);
    await page.waitForFunction(() => window.relayRecordingState?.connected === true);
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
    let offset = 12;
    while (offset + 8 < result.length && result.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + result.readUInt32LE(offset + 4) + (result.readUInt32LE(offset + 4) & 1);
    const pcm = result.subarray(offset + 8);
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
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', resolve); });
    await rm(directory, { recursive: true, force: true });
  }
});
