import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const serverUrl = new URL('../src/server.ts', import.meta.url);
const transportModuleUrl = new URL('../public/audio-transport.js', import.meta.url);

test('production counts only post-AudioSession accepted Mic samples', async () => {
  const server = await readFile(serverUrl, 'utf8');
  assert.match(server, /const micRuntime = new MicRuntime\(\{[\s\S]*?acceptedSampleRate:\s*MIX_SAMPLE_RATE,/);
  assert.match(server, /function noteMicFrame\(nowMs: number,\s*acceptedSamples: number\)[\s\S]*?micRuntime\.noteFrame\(nowMs,\s*acceptedSamples\);/);
  assert.match(server, /if \(samples\.length > 0\) noteMicFrame\(nowMs,\s*samples\.length\);/);
});

test('real PreferredAudioTransport reacts to sustained low accepted duration', async () => {
  const { PreferredAudioTransport } = await import(transportModuleUrl.href);
  const listeners = new Map<string, Set<(event: { data: string }) => void>>();
  const closes: Array<{ code?: number; reason?: string }> = [];
  let readyState = 1;
  const socket: any = {
    get readyState() { return readyState; },
    bufferedAmount: 0,
    send() {},
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
      readyState = 2;
    },
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: (event: { data: string }) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const emitAck = (message: unknown) => {
    for (const listener of listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  };

  const transport = new PreferredAudioTransport({ WebTransportClass: undefined });
  transport.bind(socket, { sampleRate: 44_100 });

  const observe = (capturedSamples: number, acceptedSampleCount: number, serial: number) => {
    assert.equal(transport.sendControlJson({
      type: 'audio-uplink-health',
      version: 1,
      captureGeneration: 7,
      capturedSamples,
      transport: { path: 'websocket' },
    }).sent, true);
    emitAck({
      type: 'audio-uplink-health-ack',
      version: 1,
      captureGeneration: 7,
      pcm: {
        acceptedFrameSerial: serial,
        acceptedSampleCount,
        acceptedSampleRate: 48_000,
        captureSampleRate: 44_100,
        mediaPath: 'websocket',
      },
    });
    return transport.lastMediaRecoveryDecision as any;
  };

  assert.equal(observe(0, 0, 0)?.reason, 'baseline');
  let decision: any;
  for (let second = 1; second <= 3; second += 1) {
    decision = observe(second * 44_100, second * 1_600, second);
  }

  assert.equal(decision?.action, 'replace-websocket');
  assert.equal(decision?.reason, 'server-pcm-under-delivered');
  assert.ok(decision?.deliveryRatio > 0 && decision?.deliveryRatio < 0.5);
  assert.deepEqual(closes, [{ code: 4001, reason: 'server PCM stalled' }]);
});
