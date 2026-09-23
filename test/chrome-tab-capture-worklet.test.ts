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

async function loadProcessor(workletSampleRate = 48_000) {
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
    sampleRate: workletSampleRate,
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

test('tab capture de-clicks a real input gap without changing its sample span', async () => {
  const processor = await loadProcessor();
  enableEnvelope(processor);

  processor.process([[new Float32Array(960).fill(0.5)]], [[new Float32Array(960)]]);
  processor.process([], [[new Float32Array(128)]]);
  processor.process([[new Float32Array(832).fill(0.5)]], [[new Float32Array(832)]]);

  const pcm = processor.port.messages.filter((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: string }).type === 'pcm'
  )) as PcmMessage[];
  assert.equal(pcm.length, 2);

  const previous = new Int16Array(pcm[0].buffer);
  const next = new Int16Array(pcm[1].buffer);
  const full = previous[previous.length - 1];
  const fadeSamples = Math.round(48_000 * 0.002);

  assert.ok(
    Math.abs(next[0] - full) <= 1,
    'the first missing backing sample continues the prior waveform instead of clicking to zero',
  );
  assert.equal(next[fadeSamples - 1], 0);
  assert.ok(
    next.slice(fadeSamples, 128).every((sample) => sample === 0),
    'the remainder of the missing render quantum stays literal silence',
  );

  assert.equal(next[128], 0, 'recovered backing starts from the emitted silence');
  assert.ok(
    Math.abs(next[128 + fadeSamples - 1] - full) <= 1,
    'backing recovery reaches the real waveform within 2 ms',
  );
  assert.ok(
    next.slice(128 + fadeSamples).every((sample) => Math.abs(sample - full) <= 1),
    'real backing PCM outside the bounded recovery edge is untouched',
  );

  let maximumStep = 0;
  for (let index = 1; index < fadeSamples; index += 1) {
    maximumStep = Math.max(
      maximumStep,
      Math.abs(next[index] - next[index - 1]),
      Math.abs(next[128 + index] - next[128 + index - 1]),
    );
  }
  assert.ok(maximumStep < 250, `backing de-click edge stepped by ${maximumStep} PCM counts`);
  assert.equal((processor as any).silenceQuanta, 1);
});

test('tab capture keeps a sub-2 ms 96 kHz input gap continuous on recovery', async () => {
  const processor = await loadProcessor(96_000);
  enableEnvelope(processor);

  processor.process([[new Float32Array(1_920).fill(0.5)]], [[new Float32Array(1_920)]]);
  processor.process([], [[new Float32Array(128)]]);
  processor.process([[new Float32Array(1_792).fill(0.5)]], [[new Float32Array(1_792)]]);

  const pcm = processor.port.messages.filter((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: string }).type === 'pcm'
  )) as PcmMessage[];
  assert.equal(pcm.length, 2);

  const previous = new Int16Array(pcm[0].buffer);
  const next = new Int16Array(pcm[1].buffer);
  const full = previous[previous.length - 1];
  const fadeSamples = Math.round(96_000 * 0.002);

  assert.ok(Math.abs(next[0] - full) <= 1);
  assert.notEqual(
    next[127],
    0,
    'a 1.33 ms gap ends before a 2 ms fade can reach zero at 96 kHz',
  );
  assert.ok(
    Math.abs(next[128] - next[127]) < 250,
    'recovery continues from the partially faded backing edge instead of stepping to zero',
  );
  assert.ok(
    Math.abs(next[128 + fadeSamples - 1] - full) <= 1,
    'the recovery crossfade returns to the real backing waveform over 2 ms',
  );
});

test('tab capture isolates non-finite channel samples without poisoning the mixed edge state', async () => {
  const processor = await loadProcessor();
  enableEnvelope(processor);

  const left = new Float32Array(960).fill(0.5);
  const right = new Float32Array(960).fill(0.5);
  right[100] = Number.NaN;
  right[101] = Number.POSITIVE_INFINITY;
  right[102] = Number.NEGATIVE_INFINITY;
  right[959] = Number.NaN;

  assert.equal(
    processor.process([[left, right]], [[new Float32Array(960)]]),
    true,
  );

  const pcm = processor.port.messages[0] as PcmMessage;
  const samples = new Int16Array(pcm.buffer);
  const full = Math.round(0.5 * 32767);
  const oneChannel = Math.round(0.25 * 32767);

  assert.ok(Math.abs(samples[99] - full) <= 1);
  for (const index of [100, 101, 102, 959]) {
    assert.ok(
      Math.abs(samples[index] - oneChannel) <= 1,
      `only the invalid channel sample at ${index} should become silence`,
    );
  }
  assert.equal(Number.isFinite((processor as any).lastOutputSample), true);

  processor.process([], [[new Float32Array(128)]]);
  assert.equal(
    Number.isFinite((processor as any).lastOutputSample),
    true,
    'backing input-gap state must remain finite after corrupt channel input',
  );
});

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
