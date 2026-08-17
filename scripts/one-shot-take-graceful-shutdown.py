from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'src/take-session.ts',
    "export type TakeStopReason = 'user' | 'mix-ended';\n",
    "export type TakeStopReason = 'user' | 'mix-ended' | 'server-shutdown';\n",
    'model controlled server shutdown as a Take terminal reason',
)

replace_once(
    'src/take-quality.ts',
    """  | 'robot-source-replaced'\n  | 'mic-owner-changed';\n""",
    """  | 'robot-source-replaced'\n  | 'mic-owner-changed'\n  | 'server-shutdown';\n""",
    'add server shutdown quality evidence',
)
replace_once(
    'src/take-quality.ts',
    """  | 'robot-delta-missing'\n  | 'transport-instability';\n""",
    """  | 'robot-delta-missing'\n  | 'transport-instability'\n  | 'recording-interrupted';\n""",
    'add interrupted recording issue',
)
replace_once(
    'src/take-quality.ts',
    """    'robot-source-replaced': 0,\n    'mic-owner-changed': 0,\n  };\n""",
    """    'robot-source-replaced': 0,\n    'mic-owner-changed': 0,\n    'server-shutdown': 0,\n  };\n""",
    'initialize server shutdown event count',
)
replace_once(
    'src/take-quality.ts',
    """  if (instabilityEvents > 0) {\n    issues.push({\n      code: 'transport-instability',\n      severity: 'warning',\n      value: instabilityEvents,\n      unit: 'events',\n      message: 'One or more source transports changed or restarted while the Take was recording.',\n    });\n  }\n\n  const verdict: TakeQualityVerdict = issues.some((issue) => issue.severity === 'critical')\n""",
    """  if (instabilityEvents > 0) {\n    issues.push({\n      code: 'transport-instability',\n      severity: 'warning',\n      value: instabilityEvents,\n      unit: 'events',\n      message: 'One or more source transports changed or restarted while the Take was recording.',\n    });\n  }\n\n  if (evidence.events['server-shutdown'] > 0) {\n    issues.push({\n      code: 'recording-interrupted',\n      severity: 'warning',\n      value: evidence.events['server-shutdown'],\n      unit: 'events',\n      message: 'Relay stopped while this Take was recording; the WAV was finalized at the shutdown boundary.',\n    });\n  }\n\n  const verdict: TakeQualityVerdict = issues.some((issue) => issue.severity === 'critical')\n""",
    'mark controlled restart Take as review',
)

replace_once(
    'src/take-controller.ts',
    """  private storagePrepared = false;\n  private pruneChain: Promise<void> = Promise.resolve();\n""",
    """  private storagePrepared = false;\n  private pruneChain: Promise<void> = Promise.resolve();\n  private finalization: Promise<void> | null = null;\n""",
    'track in-flight WAV finalization',
)
replace_once(
    'src/take-controller.ts',
    """    void writer.finalize()\n      .then((file) => {\n        const base = this.options.artifactBaseUrl ?? '/takes';\n        const completed = this.session.complete(takeId, {\n          fileName: file.fileName,\n          url: `${base}/${encodeURIComponent(takeId)}.wav`,\n          mimeType: 'audio/wav',\n          sizeBytes: file.sizeBytes,\n          sampleRate: file.sampleRate,\n          channels: 1,\n          bitsPerSample: 16,\n          sampleCount: file.sampleCount,\n          durationMs: file.durationMs,\n        });\n        if (completed) {\n          this.emitChange();\n          this.scheduleRetentionPrune();\n        } else {\n          // A finalized file without a matching ready Take is not a valid\n          // artifact and must not become an unreferenced disk leak.\n          void writer.discardFinalized();\n        }\n      })\n      .catch((error) => {\n        if (this.session.fail(takeId, errorMessage(error), Date.now())) this.emitChange();\n        void writer.abort();\n      });\n\n    return decision;\n""",
    """    const finalization = this.finalizeWriter(writer, takeId);\n    this.finalization = finalization;\n    void finalization.then(() => {\n      if (this.finalization === finalization) this.finalization = null;\n    });\n\n    return decision;\n""",
    'make Take finalization awaitable',
)
replace_once(
    'src/take-controller.ts',
    """  shutdown() {\n    const writer = this.writer;\n    this.writer = null;\n    this.quality = null;\n    if (writer) void writer.abort();\n  }\n\n  private failWriter(writer: WavTakeWriter, error: unknown) {\n""",
    """  async shutdown(nowMs = Date.now()) {\n    const recordingTakeId = this.session.recordingTakeId;\n    if (recordingTakeId) {\n      this.quality?.noteEvent('server-shutdown');\n      this.stop(recordingTakeId, null, 'server-shutdown', nowMs);\n    }\n\n    const finalization = this.finalization;\n    if (finalization) await finalization;\n\n    // This only covers an impossible/failed lifecycle mismatch. A normal\n    // recording or finalizing Take has already been drained above.\n    const orphanWriter = this.writer;\n    this.writer = null;\n    this.quality = null;\n    if (orphanWriter) await orphanWriter.abort();\n    await this.pruneChain;\n  }\n\n  private async finalizeWriter(writer: WavTakeWriter, takeId: string) {\n    try {\n      const file = await writer.finalize();\n      const base = this.options.artifactBaseUrl ?? '/takes';\n      const completed = this.session.complete(takeId, {\n        fileName: file.fileName,\n        url: `${base}/${encodeURIComponent(takeId)}.wav`,\n        mimeType: 'audio/wav',\n        sizeBytes: file.sizeBytes,\n        sampleRate: file.sampleRate,\n        channels: 1,\n        bitsPerSample: 16,\n        sampleCount: file.sampleCount,\n        durationMs: file.durationMs,\n      });\n      if (completed) {\n        this.emitChange();\n        this.scheduleRetentionPrune();\n      } else {\n        // A finalized file without a matching ready Take is not a valid\n        // artifact and must not become an unreferenced disk leak.\n        await writer.discardFinalized();\n      }\n    } catch (error) {\n      if (this.session.fail(takeId, errorMessage(error), Date.now())) this.emitChange();\n      await writer.abort();\n    }\n  }\n\n  private failWriter(writer: WavTakeWriter, error: unknown) {\n""",
    'drain recording/finalizing Take before process shutdown',
)

replace_once(
    'test/helpers/harness.ts',
    """  httpUrl: (pathname?: string) => string;\n  stop: () => Promise<void>;\n};\n""",
    """  httpUrl: (pathname?: string) => string;\n  signal: (signal?: NodeJS.Signals) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;\n  stop: () => Promise<void>;\n};\n""",
    'expose child signal for process lifecycle tests',
)
replace_once(
    'test/helpers/harness.ts',
    """    const stop = () => new Promise<void>((done) => {\n      if (child.exitCode !== null || child.signalCode !== null) {\n        done();\n        return;\n      }\n      child.once('exit', () => done());\n      child.kill();\n    });\n""",
    """    const signal = (signal: NodeJS.Signals = 'SIGTERM') => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {\n      if (child.exitCode !== null || child.signalCode !== null) {\n        done({ code: child.exitCode, signal: child.signalCode });\n        return;\n      }\n      child.once('exit', (code, exitSignal) => done({ code, signal: exitSignal }));\n      child.kill(signal);\n    });\n\n    const stop = async () => {\n      await signal('SIGTERM');\n    };\n""",
    'make test server stoppage explicit SIGTERM',
)
replace_once(
    'test/helpers/harness.ts',
    """        httpUrl: (pathname = '/') => `http://127.0.0.1:${port}${pathname}`,\n        stop,\n""",
    """        httpUrl: (pathname = '/') => `http://127.0.0.1:${port}${pathname}`,\n        signal,\n        stop,\n""",
    'return process signal helper',
)

replace_once(
    'src/server.ts',
    """wss.on('close', () => {\n  cancelMicTransportGrace();\n  takeController.shutdown();\n  clearMicMediaAuthority();\n  void webTransportMedia?.stop();\n  clearInterval(heartbeat);\n  clearInterval(mixerTimer);\n  clearInterval(youtubeTimelineTimer);\n});\n""",
    """wss.on('close', () => {\n  cancelMicTransportGrace();\n  clearMicMediaAuthority();\n  clearInterval(heartbeat);\n  clearInterval(mixerTimer);\n  clearInterval(youtubeTimelineTimer);\n});\n""",
    'move durable Take/WebTransport cleanup to explicit shutdown seam',
)
replace_once(
    'src/server.ts',
    """server.listen(port, '0.0.0.0', () => {\n  const address = server.address();\n  const actualPort = typeof address === 'object' && address ? address.port : port;\n  console.log(`Relay listening on http://localhost:${actualPort}`);\n  console.log('For a phone, expose this HTTP server through an HTTPS tunnel before using the microphone.');\n});\n""",
    """server.listen(port, '0.0.0.0', () => {\n  const address = server.address();\n  const actualPort = typeof address === 'object' && address ? address.port : port;\n  console.log(`Relay listening on http://localhost:${actualPort}`);\n  console.log('For a phone, expose this HTTP server through an HTTPS tunnel before using the microphone.');\n});\n\nlet shutdownPromise: Promise<void> | null = null;\n\nasync function gracefulShutdown(signal: NodeJS.Signals) {\n  if (shutdownPromise) return shutdownPromise;\n  shutdownPromise = (async () => {\n    console.log(`Relay received ${signal}; finalizing active work before shutdown.`);\n\n    // Stop producing new mixed frames before closing the WAV boundary. Signal\n    // callbacks run between JS turns, so no mixer callback can race this clear.\n    clearInterval(mixerTimer);\n    clearInterval(youtubeTimelineTimer);\n    clearInterval(heartbeat);\n    cancelMicTransportGrace();\n    cancelBackingGrace();\n\n    await takeController.shutdown(Date.now());\n    await webTransportMedia?.stop();\n\n    for (const client of wss.clients) client.terminate();\n    await new Promise<void>((resolve) => wss.close(() => resolve()));\n    if (server.listening) {\n      await new Promise<void>((resolve, reject) => {\n        server.close((error) => error ? reject(error) : resolve());\n      });\n    }\n  })().catch((error) => {\n    console.error('Relay graceful shutdown failed', error);\n    process.exitCode = 1;\n  });\n  return shutdownPromise;\n}\n\nfor (const signal of ['SIGTERM', 'SIGINT'] as const) {\n  process.once(signal, () => {\n    void gracefulShutdown(signal).finally(() => {\n      process.exit(process.exitCode ?? 0);\n    });\n  });\n}\n""",
    'install awaited controlled shutdown boundary',
)

Path('test/server-take-shutdown.test.ts').write_text("""import assert from 'node:assert/strict';
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

test('SIGTERM finalizes an active Take before Relay exits and preserves the WAV across restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-shutdown-'));
  let first: Awaited<ReturnType<typeof startRelay>> | null = null;
  let second: Awaited<ReturnType<typeof startRelay>> | null = null;
  try {
    const env = {
      RELAY_TAKE_DIR: directory,
      RELAY_AUTO_CALIBRATE: '0',
      RELAY_CALIBRATION_PROBE: '0',
      RELAY_HEARTBEAT_MS: '60000',
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
    await sleep(80);

    const readyDuringShutdown = singer.waitFor(
      (message) => message.type === 'take-status'
        && message.lifecycle === 'ready'
        && message.take?.takeId === takeId,
      5_000,
    );
    const exit = first.signal('SIGTERM');
    const ready = await readyDuringShutdown;
    const exited = await exit;
    first = null;

    assert.equal(exited.code, 0);
    assert.equal(exited.signal, null, 'the server should consume SIGTERM and exit after its awaited drain');
    assert.equal(ready.take.stopReason, 'server-shutdown');
    assert.equal(ready.take.quality?.verdict, 'review');
    assert.ok(ready.take.quality?.issues?.some((issue: any) => issue.code === 'recording-interrupted'));

    const files = await readdir(directory);
    assert.ok(files.includes(`${takeId}.wav`), 'controlled restart must leave a finalized WAV');
    assert.ok(!files.includes(`${takeId}.wav.part`), 'controlled restart must not leave a partial artifact');
    const wav = await readFile(path.join(directory, `${takeId}.wav`));
    assert.ok(wav.byteLength > 44, 'finalized shutdown artifact must contain recorded PCM');
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');

    second = await startRelay(env);
    const response = await fetch(second.httpUrl(`/takes/${takeId}.wav`));
    assert.equal(response.status, 200, 'the finalized artifact must survive startup cleanup');
    const restoredBytes = Buffer.from(await response.arrayBuffer());
    assert.equal(restoredBytes.byteLength, wav.byteLength);
  } finally {
    await first?.stop();
    await second?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
""")
