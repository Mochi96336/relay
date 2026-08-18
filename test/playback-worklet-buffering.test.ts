import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SAMPLE_RATE = 48_000;

async function makeProcessor(options: Record<string, number> = {}) {
  const source = await readFile(new URL('../public/playback-worklet.js', import.meta.url), 'utf8');
  let RegisteredProcessor: any = null;

  class MockAudioWorkletProcessor {
    port: {
      messages: unknown[];
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (message: unknown) => void;
    };

    constructor() {
      const messages: unknown[] = [];
      this.port = {
        messages,
        onmessage: null,
        postMessage: (message) => messages.push(message),
      };
    }
  }

  vm.runInNewContext(source, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    ArrayBuffer,
    Float32Array,
    Math,
    Number,
    sampleRate: SAMPLE_RATE,
    registerProcessor(_name: string, Processor: unknown) {
      RegisteredProcessor = Processor;
    },
  });

  assert.ok(RegisteredProcessor);
  const processor = new RegisteredProcessor();
  processor.configure({ prebufferMs: 250, maxQueueMs: 800, ...options });
  return processor;
}

function outputBlock() {
  return [[new Float32Array(128)]];
}

function runUntilUnderrun(processor: any) {
  const before = processor.underruns;
  let guard = 10_000;
  while (processor.underruns === before && guard > 0) {
    processor.process([], outputBlock());
    guard -= 1;
  }
  assert.ok(guard > 0, 'expected playback to reach an underrun');
}

test('starts at 100 ms instead of the legacy 250 ms ceiling', async () => {
  const processor = await makeProcessor();
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);
  assert.equal(processor.maxPrebufferSamples, SAMPLE_RATE * 0.25);

  processor.push(new Float32Array(SAMPLE_RATE * 0.09));
  processor.process([], outputBlock());
  assert.equal(processor.playing, false);

  processor.push(new Float32Array(SAMPLE_RATE * 0.02));
  processor.process([], outputBlock());
  assert.equal(processor.playing, true);
});

test('raises the next rebuffer target after short underruns and caps at 250 ms', async () => {
  const processor = await makeProcessor();

  for (const expectedMs of [150, 200, 250, 250]) {
    processor.push(new Float32Array(processor.maxPrebufferSamples));
    runUntilUnderrun(processor);
    const beforeRecovery = processor.prebufferSamples;

    // The first packet after a short gap is the evidence that this was jitter,
    // not an intentional end of stream. Raise before the next playback start.
    processor.push(new Float32Array(128));
    assert.ok(processor.prebufferSamples >= beforeRecovery);
    assert.equal(processor.prebufferSamples, SAMPLE_RATE * expectedMs / 1000);

    // Keep each adaptation cycle independent while preserving the learned target.
    processor.reset();
  }
});

test('does not ratchet latency upward after a long idle gap', async () => {
  const processor = await makeProcessor({ recoveryWindowMs: 10 });
  processor.push(new Float32Array(processor.maxPrebufferSamples));
  runUntilUnderrun(processor);
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);

  // Four 128-sample worklet blocks are >10 ms at 48 kHz. Audio arriving after
  // that is a new/long-lived stream, not jitter a 250 ms buffer can repair.
  for (let i = 0; i < 4; i += 1) processor.process([], outputBlock());
  processor.push(new Float32Array(128));
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);
});

test('stable playback lowers the future rebuffer target slowly and reset keeps the learned target', async () => {
  const processor = await makeProcessor({ initialPrebufferMs: 150, stableWindowMs: 10 });
  processor.push(new Float32Array(SAMPLE_RATE * 0.2));

  for (let i = 0; i < 4; i += 1) processor.process([], outputBlock());
  assert.equal(processor.prebufferSamples, Math.round(SAMPLE_RATE * 0.14));

  processor.reset();
  assert.equal(processor.prebufferSamples, Math.round(SAMPLE_RATE * 0.14));
  assert.equal(processor.playing, false);
});
