import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapturedProcessor = {
  process(inputs: unknown[], outputs: unknown[]): boolean;
  port: {
    messages: unknown[];
    onmessage?: ((event: { data: unknown }) => void) | null;
  };
};

type PcmMessage = {
  type: 'pcm';
  buffer: ArrayBuffer;
  capturedAtContextTime: number | null;
};

async function loadProcessor() {
  let registeredName: string | null = null;
  let RegisteredProcessor: (new () => CapturedProcessor) | null = null;

  class FakeAudioWorkletProcessor {
    port = {
      messages: [] as unknown[],
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: unknown) => {
        this.port.messages.push(message);
      },
    };
  }

  const source = await readFile(
    path.resolve('chrome-tab-audio-probe/capture-worklet.js'),
    'utf8',
  );
  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    sampleRate: 48_000,
    currentTime: 12.5,
    registerProcessor: (name: string, processor: new () => CapturedProcessor) => {
      registeredName = name;
      RegisteredProcessor = processor;
    },
  });

  assert.equal(registeredName, 'relay-tab-capture');
  if (!RegisteredProcessor) throw new Error('relay-tab-capture was not registered');
  const Processor = RegisteredProcessor as unknown as new () => CapturedProcessor;
  return new Processor();
}

function enableEnvelope(processor: CapturedProcessor) {
  processor.port.onmessage?.({
    data: { type: 'capture-protocol', pcmEnvelope: true },
  });
}

test('tab capture worklet defaults to raw PCM for rollout compatibility', async () => {
  const processor = await loadProcessor();
  const input = new Float32Array(960).fill(0.25);

  assert.equal(processor.process([[input]], [[new Float32Array(960)]]), true);
  assert.equal(Object.prototype.toString.call(processor.port.messages[0]), '[object ArrayBuffer]');
});

test('new offscreen opt-in enables chunk-start capture timestamps', async () => {
  const processor = await loadProcessor();
  enableEnvelope(processor);

  const input = new Float32Array(1_920).fill(0.25);
  assert.equal(processor.process([[input]], [[new Float32Array(1_920)]]), true);

  const first = processor.port.messages[0] as PcmMessage;
  const second = processor.port.messages[1] as PcmMessage;
  assert.equal(first.type, 'pcm');
  assert.equal(Object.prototype.toString.call(first.buffer), '[object ArrayBuffer]');
  assert.equal(first.capturedAtContextTime, 12.5);
  assert.equal(second.type, 'pcm');
  assert.ok(
    Math.abs((second.capturedAtContextTime ?? 0) - 12.52) < 1e-9,
    `second chunk must start at 12.52 s, got ${second.capturedAtContextTime}`,
  );
});
