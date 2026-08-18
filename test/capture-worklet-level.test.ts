import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
  port: { messages: unknown[] };
};

function loadCaptureProcessor() {
  let registeredName: string | null = null;
  let RegisteredProcessor: (new () => CapturedProcessor) | null = null;

  class FakeAudioWorkletProcessor {
    port = {
      messages: [] as unknown[],
      postMessage: (message: unknown) => {
        this.port.messages.push(message);
      },
    };
  }

  return readFile(path.resolve('public/capture-worklet.js'), 'utf8').then((source) => {
    vm.runInNewContext(source, {
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
      sampleRate: 48_000,
      registerProcessor: (name: string, processor: new () => CapturedProcessor) => {
        registeredName = name;
        RegisteredProcessor = processor;
      },
    });

    assert.equal(registeredName, 'capture-processor');
    if (!RegisteredProcessor) throw new Error('capture-processor was not registered');
    return new RegisteredProcessor();
  });
}

test('capture worklet publishes 20 ms local level evidence beside PCM', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(960).fill(0.5);

  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.port.messages.length, 2);

  const level = processor.port.messages[0] as {
    type: string;
    peakDbfs: number;
    rmsDbfs: number;
    samples: number;
  };
  assert.equal(level.type, 'input-level');
  assert.equal(level.samples, 960);
  assert.ok(Math.abs(level.peakDbfs - (-6.020599913279624)) < 0.0001);
  assert.ok(Math.abs(level.rmsDbfs - (-6.020599913279624)) < 0.0001);
  assert.equal(Object.prototype.toString.call(processor.port.messages[1]), '[object ArrayBuffer]');
});

test('capture worklet includes padded input gaps in local level timing', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(896).fill(0.25);

  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.process([]), true);

  const level = processor.port.messages.find((message) => (
    typeof message === 'object' && message !== null && (message as { type?: string }).type === 'input-level'
  )) as { samples: number; peakDbfs: number; rmsDbfs: number } | undefined;

  assert.ok(level);
  assert.equal(level.samples, 960);
  assert.ok(Math.abs(level.peakDbfs - (-12.041199826559248)) < 0.0001);
  assert.ok(level.rmsDbfs < level.peakDbfs, 'padded silence should lower RMS without changing peak');
});
