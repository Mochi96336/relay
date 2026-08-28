import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;

function pcm(samples = 960, value = 1200) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(value, index * 2);
  return buffer;
}

for (const shutdownSignal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${shutdownSignal} remains graceful when repeated during active Take finalization`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-shutdown-'));
    let first: Awaited<ReturnType<typeof startRelay>> | null = null;
    let second: Awaited<ReturnType<typeof startRelay>> | null = null;
    try {
      const env = {
        RELAY_TAKE_DIR: directory,
        RELAY_AUTO_CALIBRATE: '0',
        RELAY_CALIBRATION_PROBE: '0',
        RELAY_HEARTBEAT_MS: '60000',
        RELAY_LIVE_PREBUFFER_MS: '1',
      };
      first = await startRelay(env);
      const singer = await RelayClient.connect(first, '?participant=shutdown-singer&name=Singer');
      singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
      await singer.waitForType('registered');
      singer.sendPcm(pcm());
      await sleep(40);

      singer.send({ type: 'start-take' });
      const recording = await singer.waitFor(
        (message) => message.type === 'take-status' && message.lifecycle === 'recording',
      );
      const takeId = String(recording.take.takeId);
      for (let index = 0; index < 6; index += 1) singer.sendPcm(pcm());
      await sleep(100);

      const readyDuringShutdown = singer.waitFor(
        (message) => message.type === 'take-status'
          && message.lifecycle === 'ready'
          && message.take?.takeId === takeId,
        5_000,
      );
      const exit = first.signal(shutdownSignal);
      // Let the first handler enter async writer finalization, then send the
      // same signal again. A one-shot signal listener restores Node's default
      // termination here and can cut the WAV flush/rename short.
      await sleep(10);
      const repeatedExit = first.signal(shutdownSignal);
      const ready = await readyDuringShutdown;
      const [exited, repeated] = await Promise.all([exit, repeatedExit]);
      first = null;

      assert.equal(exited.code, 0);
      assert.equal(exited.signal, null);
      assert.equal(repeated.code, 0);
      assert.equal(repeated.signal, null);
      assert.equal(ready.take.stopReason, 'server-shutdown');
      assert.equal(
        ready.take.quality?.evidence?.events?.['server-shutdown'],
        1,
        `shutdown event missing from final Take quality: ${JSON.stringify(ready.take.quality)}`,
      );
      assert.equal(
        ready.take.quality?.verdict,
        'review',
        `controlled shutdown must not masquerade as a clean Take: ${JSON.stringify(ready.take.quality)}`,
      );
      assert.ok(
        ready.take.quality?.issues?.some((issue: any) => issue.code === 'recording-interrupted'),
        `controlled shutdown must publish recording-interrupted: ${JSON.stringify(ready.take.quality)}`,
      );
      assert.ok(
        Number(ready.take.artifact?.sampleCount) > 0,
        `fault injection must happen after authoritative mixed PCM reached the Take: ${JSON.stringify(ready.take.artifact)}`,
      );

      const files = await readdir(directory);
      assert.ok(files.includes(`${takeId}.wav`));
      assert.ok(!files.includes(`${takeId}.wav.part`));
      const wav = await readFile(path.join(directory, `${takeId}.wav`));
      assert.ok(wav.byteLength > 44);
      assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
      assert.equal((wav.byteLength - 44) / 2, Number(ready.take.artifact.sampleCount));

      second = await startRelay(env);
      const response = await fetch(second.httpUrl(`/takes/${takeId}.wav`));
      assert.equal(response.status, 200);
      const restoredBytes = Buffer.from(await response.arrayBuffer());
      assert.equal(restoredBytes.byteLength, wav.byteLength);
    } finally {
      await first?.stop();
      await second?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
