import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
  port: { messages: unknown[] };
  measureF0(rms: number): void;
};

type InputLevel = {
  type: string;
  peakDbfs: number;
  rmsDbfs: number;
  spectrumBands: number[];
  f0Hz: number | null;
  pitchConfidence: number;
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

function sine(frequencyHz: number, durationMs = 120, amplitude = 0.4) {
  const length = Math.round((48_000 * durationMs) / 1000);
  return Float32Array.from({ length }, (_, index) => (
    Math.sin((2 * Math.PI * frequencyHz * index) / 48_000) * amplitude
  ));
}

function latestLevel(processor: CapturedProcessor) {
  return processor.port.messages.filter((message) => (
    typeof message === 'object' && message !== null && (message as { type?: string }).type === 'input-level'
  )).at(-1) as InputLevel | undefined;
}

test('capture worklet publishes local RMS, five-band spectrum and F0 evidence beside untouched PCM', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(960).fill(0.5);
  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.port.messages.length, 2);
  assert.equal(Object.prototype.toString.call(processor.port.messages[0]), '[object ArrayBuffer]');
  const level = processor.port.messages[1] as InputLevel;
  assert.equal(level.type, 'input-level');
  assert.equal(level.samples, 960);
  assert.ok(Math.abs(level.peakDbfs - (-6.020599913279624)) < 0.0001);
  assert.ok(Math.abs(level.rmsDbfs - (-6.020599913279624)) < 0.0001);
  assert.equal(level.spectrumBands.length, 5);
  assert.equal(level.f0Hz, null, 'DC must not be guessed as a pitch');
  assert.equal(level.pitchConfidence, 0);
});

test('capture worklet transfers each PCM chunk before entering F0 visual analysis', async () => {
  const processor = await loadCaptureProcessor();
  const originalMeasureF0 = processor.measureF0.bind(processor);
  processor.measureF0 = (rms) => {
    processor.port.messages.push('f0-analysis');
    originalMeasureF0(rms);
  };

  processor.process([[sine(220, 40)]]);
  assert.equal(Object.prototype.toString.call(processor.port.messages[0]), '[object ArrayBuffer]');
  assert.equal(processor.port.messages[1], 'f0-analysis');
  assert.equal((processor.port.messages[2] as InputLevel).type, 'input-level');
  assert.equal(Object.prototype.toString.call(processor.port.messages[3]), '[object ArrayBuffer]');
  assert.equal(processor.port.messages[4], 'f0-analysis');
  assert.equal((processor.port.messages[5] as InputLevel).type, 'input-level');
});

test('capture spectrum remains frequency-shape evidence, separate from pitch', async () => {
  const lowProcessor = await loadCaptureProcessor();
  lowProcessor.process([[sine(187.5, 20)]]);
  const low = latestLevel(lowProcessor)!;
  assert.ok(low.spectrumBands[0] > low.spectrumBands[4]);
  const highProcessor = await loadCaptureProcessor();
  highProcessor.process([[sine(3000, 20)]]);
  const high = latestLevel(highProcessor)!;
  assert.ok(high.spectrumBands[4] > high.spectrumBands[0]);
});

for (const frequencyHz of [100, 220, 440]) {
  test(`F0 detector tracks a ${frequencyHz} Hz sine`, async () => {
    const processor = await loadCaptureProcessor();
    processor.process([[sine(frequencyHz)]]);
    const level = latestLevel(processor)!;
    assert.ok(level.f0Hz !== null);
    assert.ok(Math.abs(level.f0Hz - frequencyHz) < 2, `expected ~${frequencyHz} Hz, got ${level.f0Hz}`);
    assert.ok(level.pitchConfidence >= 0.8);
  });
}

test('F0 detector returns null for silence and low confidence for noise', async () => {
  const silence = await loadCaptureProcessor();
  silence.process([[new Float32Array(5_760)]]);
  const silentLevel = latestLevel(silence)!;
  assert.equal(silentLevel.f0Hz, null);
  assert.equal(silentLevel.pitchConfidence, 0);
  const noise = await loadCaptureProcessor();
  const random = new Float32Array(5_760);
  let state = 0x1234_5678;
  for (let index = 0; index < random.length; index += 1) {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    random[index] = ((state / 0x1_0000_0000) * 2 - 1) * 0.4;
  }
  noise.process([[random]]);
  const noiseLevel = latestLevel(noise)!;
  assert.equal(noiseLevel.f0Hz, null);
  assert.ok(noiseLevel.pitchConfidence < 0.6);
});

test('F0 detector prefers the fundamental in a harmonic-rich singing signal', async () => {
  const processor = await loadCaptureProcessor();
  const fundamentalHz = 110;
  const input = Float32Array.from({ length: 5_760 }, (_, index) => {
    const phase = (2 * Math.PI * fundamentalHz * index) / 48_000;
    return 0.12 * Math.sin(phase) + 0.35 * Math.sin(phase * 2) + 0.2 * Math.sin(phase * 3);
  });
  processor.process([[input]]);
  const level = latestLevel(processor)!;
  assert.ok(level.f0Hz !== null);
  assert.ok(Math.abs(level.f0Hz - fundamentalHz) < 2, `expected ~110 Hz, got ${level.f0Hz}`);
});

test('capture worklet includes padded input gaps in local level timing', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(896).fill(0.25);
  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.process([]), true);
  const level = latestLevel(processor);
  assert.ok(level);
  assert.equal(level.samples, 960);
  assert.equal(level.spectrumBands.length, 5);
  assert.ok(Math.abs(level.peakDbfs - (-12.041199826559248)) < 0.0001);
  assert.ok(level.rmsDbfs < level.peakDbfs);
});
