import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
  port: { messages: unknown[] };
};

type InputLevel = {
  type: string;
  peakDbfs: number;
  rmsDbfs: number;
  spectrumBands: number[];
  samples: number;
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

function sine(frequencyHz: number, amplitude = 0.4) {
  return Float32Array.from({ length: 960 }, (_, index) => (
    Math.sin((2 * Math.PI * frequencyHz * index) / 48_000) * amplitude
  ));
}

test('capture worklet publishes 20 ms local level and five-band spectrum evidence beside PCM', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(960).fill(0.5);

  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.port.messages.length, 2);

  const level = processor.port.messages[0] as InputLevel;
  assert.equal(level.type, 'input-level');
  assert.equal(level.samples, 960);
  assert.ok(Math.abs(level.peakDbfs - (-6.020599913279624)) < 0.0001);
  assert.ok(Math.abs(level.rmsDbfs - (-6.020599913279624)) < 0.0001);
  assert.equal(level.spectrumBands.length, 5);
  assert.equal(level.spectrumBands.every(Number.isFinite), true);
  assert.equal(level.spectrumBands.every((value) => value >= 0 && value <= 1), true);
  assert.equal(Object.prototype.toString.call(processor.port.messages[1]), '[object ArrayBuffer]');
});

test('capture spectrum distinguishes low and high local Mic energy', async () => {
  const lowProcessor = await loadCaptureProcessor();
  lowProcessor.process([[sine(187.5)]]);
  const low = lowProcessor.port.messages[0] as InputLevel;
  assert.ok(low.spectrumBands[0] > low.spectrumBands[4], '187.5 Hz should read stronger in the lowest band');

  const highProcessor = await loadCaptureProcessor();
  highProcessor.process([[sine(3000)]]);
  const high = highProcessor.port.messages[0] as InputLevel;
  assert.ok(high.spectrumBands[4] > high.spectrumBands[0], '3 kHz should read stronger in the highest band');
});

test('capture worklet includes padded input gaps in local level timing', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(896).fill(0.25);

  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.process([]), true);

  const level = processor.port.messages.find((message) => (
    typeof message === 'object' && message !== null && (message as { type?: string }).type === 'input-level'
  )) as InputLevel | undefined;

  assert.ok(level);
  assert.equal(level.samples, 960);
  assert.equal(level.spectrumBands.length, 5);
  assert.ok(Math.abs(level.peakDbfs - (-12.041199826559248)) < 0.0001);
  assert.ok(level.rmsDbfs < level.peakDbfs, 'padded silence should lower RMS without changing peak');
});
