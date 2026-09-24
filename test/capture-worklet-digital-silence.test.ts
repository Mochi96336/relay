import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
  port: { messages: unknown[] };
};

type InputGap = {
  type: 'input-gap';
  quanta: number;
  samples: number;
  recovered: boolean;
  reason?: string;
};

const RATE = 48_000;
const QUANTUM = 128;

async function loadCaptureProcessor() {
  const source = await readFile(path.resolve('public/capture-worklet.js'), 'utf8');
  let Registered: (new () => CapturedProcessor) | null = null;
  class FakeAudioWorkletProcessor {
    port = {
      messages: [] as unknown[],
      onmessage: null,
      postMessage: (message: unknown) => {
        this.port.messages.push(message);
      },
    };
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    sampleRate: RATE,
    currentTime: 0,
    registerProcessor: (_name: string, processor: new () => CapturedProcessor) => {
      Registered = processor;
    },
  });
  if (!Registered) throw new Error('capture-processor was not registered');
  return new (Registered as new () => CapturedProcessor)();
}

function gaps(processor: CapturedProcessor) {
  return processor.port.messages.filter((message) => (
    (message as { type?: string }).type === 'input-gap'
  )) as InputGap[];
}

function run(processor: CapturedProcessor, ms: number, value: (index: number) => number) {
  const quanta = Math.round((ms * RATE) / 1000 / QUANTUM);
  for (let quantum = 0; quantum < quanta; quantum += 1) {
    const input = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i += 1) input[i] = value(quantum * QUANTUM + i);
    processor.process([[input]]);
  }
}

const zero = () => 0;
const noiseFloor = (index: number) => (index % 8 < 4 ? 1 : -1) / 32768;

test('seconds of exact digital zero from a present input are reported as a source gap', async () => {
  const processor = await loadCaptureProcessor();
  run(processor, 1_900, zero);
  assert.deepEqual(gaps(processor), [], 'a short silent stretch is not a failure');

  run(processor, 200, zero);
  assert.deepEqual(gaps(processor).map(({ recovered, reason, samples }) => ({ recovered, reason, samples })), [
    { recovered: false, reason: 'digital-silence', samples: 0 },
  ], 'the edge carries no padded samples: the zeros were real PCM on the timeline');

  run(processor, 1_000, zero);
  assert.equal(gaps(processor).length, 1, 'an ongoing silence is reported once');

  run(processor, 20, noiseFloor);
  assert.deepEqual({ ...gaps(processor).at(-1) }, {
    type: 'input-gap',
    quanta: 0,
    samples: 0,
    totalQuanta: 0,
    recovered: true,
    reason: 'digital-silence',
  });
});

test('a quiet room at the noise floor is never mistaken for digital silence', async () => {
  const processor = await loadCaptureProcessor();
  run(processor, 5_000, noiseFloor);
  assert.deepEqual(gaps(processor), []);
});

test('a missing input channel keeps its own gap report and resets the silence run', async () => {
  const processor = await loadCaptureProcessor();
  run(processor, 1_500, zero);
  // One missing render quantum: the ordinary input-gap path owns it.
  processor.process([[]]);
  run(processor, 1_500, zero);
  assert.equal(
    gaps(processor).filter((gap) => gap.reason === 'digital-silence').length,
    0,
    'silence either side of a missing quantum does not accumulate across it',
  );
});
