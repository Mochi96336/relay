import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
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

type InputLevel = {
  type: string;
  peakDbfs: number;
  rmsDbfs: number;
  spectrumBands: number[];
  f0Hz: number | null;
  pitchConfidence: number;
  samples: number;
  railSamples: number;
  maxConsecutiveRailSamples: number;
};

async function captureWorkletSource() {
  return readFile(path.resolve('public/capture-worklet.js'), 'utf8');
}

function loadCaptureProcessor() {
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

  return captureWorkletSource().then((source) => {
    vm.runInNewContext(source, {
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
      sampleRate: 48_000,
      currentTime: 12.5,
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

function latestLevel(processor: CapturedProcessor) {
  return processor.port.messages.filter((message) => (
    typeof message === 'object' && message !== null && (message as { type?: string }).type === 'input-level'
  )).at(-1) as InputLevel | undefined;
}

function enablePcmEnvelope(processor: CapturedProcessor) {
  processor.port.onmessage?.({
    data: { type: 'capture-protocol', pcmEnvelope: true },
  });
}

test('capture worklet defaults to raw PCM until a new app opts into the envelope', async () => {
  const legacyPage = await loadCaptureProcessor();
  legacyPage.process([[new Float32Array(960).fill(0.25)]]);
  assert.equal(
    Object.prototype.toString.call(legacyPage.port.messages[0]),
    '[object ArrayBuffer]',
    'an old app kept open across deploy must still receive the raw PCM shape it understands',
  );

  const newPage = await loadCaptureProcessor();
  enablePcmEnvelope(newPage);
  newPage.process([[new Float32Array(960).fill(0.25)]]);
  const pcm = newPage.port.messages[0] as PcmMessage;
  assert.equal(pcm.type, 'pcm');
  assert.equal(Object.prototype.toString.call(pcm.buffer), '[object ArrayBuffer]');
  assert.equal(pcm.capturedAtContextTime, 12.5);
});

test('capture worklet publishes level evidence beside untouched PCM with rollout-safe visual placeholders', async () => {
  const processor = await loadCaptureProcessor();
  enablePcmEnvelope(processor);
  const input = new Float32Array(960).fill(0.5);
  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.port.messages.length, 2);
  const pcm = processor.port.messages[0] as PcmMessage;
  assert.equal(pcm.type, 'pcm');
  assert.equal(Object.prototype.toString.call(pcm.buffer), '[object ArrayBuffer]');
  assert.equal(pcm.capturedAtContextTime, 12.5);

  const level = processor.port.messages[1] as InputLevel;
  assert.equal(level.type, 'input-level');
  assert.equal(level.samples, 960);
  assert.ok(Math.abs(level.peakDbfs - (-6.020599913279624)) < 0.0001);
  assert.ok(Math.abs(level.rmsDbfs - (-6.020599913279624)) < 0.0001);
  assert.deepEqual(Array.from(level.spectrumBands), [0, 0, 0, 0, 0]);
  assert.equal(level.f0Hz, null);
  assert.equal(level.pitchConfidence, 0);
});

test('capture rail evidence distinguishes isolated full-scale peaks from flat-top clipping', async () => {
  const clean = await loadCaptureProcessor();
  const sine = new Float32Array(960);
  for (let index = 0; index < sine.length; index += 1) {
    sine[index] = Math.sin((2 * Math.PI * 1_000 * index) / 48_000);
  }
  clean.process([[sine]]);
  const cleanLevel = latestLevel(clean);
  assert.ok(cleanLevel);
  assert.ok(cleanLevel.railSamples > 0, 'the regression should include exact full-scale sine peaks');
  assert.ok(
    cleanLevel.maxConsecutiveRailSamples <= 1,
    `an unclipped sine should not flatten at the rail, got run ${cleanLevel.maxConsecutiveRailSamples}`,
  );

  const clipped = await loadCaptureProcessor();
  const flatTop = new Float32Array(960).fill(0.25);
  flatTop.fill(1, 200, 208);
  clipped.process([[flatTop]]);
  const clippedLevel = latestLevel(clipped);
  assert.ok(clippedLevel);
  assert.equal(clippedLevel.railSamples, 8);
  assert.equal(clippedLevel.maxConsecutiveRailSamples, 8);
});

test('capture rail runs remain continuous across 20 ms level-message boundaries', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(1_920).fill(0.25);
  input.fill(1, 958, 964);
  processor.process([[input]]);

  const levels = processor.port.messages.filter((message) => (
    typeof message === 'object' && message !== null && (message as { type?: string }).type === 'input-level'
  )) as InputLevel[];
  assert.equal(levels.length, 2);
  assert.equal(levels[0].maxConsecutiveRailSamples, 2);
  assert.equal(levels[1].railSamples, 6, 'rail sample count is capture-lifetime cumulative');
  assert.equal(
    levels[1].maxConsecutiveRailSamples,
    6,
    'a flat top crossing a chunk boundary must remain one continuous run',
  );
});

test('realtime capture worklet contains no FFT or pitch detector', async () => {
  const source = await captureWorkletSource();
  assert.doesNotMatch(source, /runFft|measureSpectrumBands|measureF0|F0_YIN_THRESHOLD|F0_RING_SIZE/);
  assert.match(source, /visual DSP can never consume an audio render deadline/);
  assert.match(source, /VISUAL_ANALYSIS_PLACEHOLDER/);
});

test('capture worklet posts every PCM chunk before its lightweight level message', async () => {
  const processor = await loadCaptureProcessor();
  enablePcmEnvelope(processor);

  const input = new Float32Array(1_920).fill(0.25);
  processor.process([[input]]);

  assert.equal((processor.port.messages[0] as PcmMessage).type, 'pcm');
  assert.equal((processor.port.messages[1] as InputLevel).type, 'input-level');
  assert.equal((processor.port.messages[2] as PcmMessage).type, 'pcm');
  assert.equal((processor.port.messages[3] as InputLevel).type, 'input-level');
  assert.ok(
    Math.abs(((processor.port.messages[2] as PcmMessage).capturedAtContextTime ?? 0) - 12.52) < 1e-9,
  );
});

test('capture worklet includes padded input gaps in local level timing', async () => {
  const processor = await loadCaptureProcessor();
  const input = new Float32Array(896).fill(0.25);
  assert.equal(processor.process([[input]]), true);
  assert.equal(processor.process([]), true);
  const level = latestLevel(processor);
  assert.ok(level);
  assert.equal(level.samples, 960);
  assert.deepEqual(Array.from(level.spectrumBands), [0, 0, 0, 0, 0]);
  assert.ok(Math.abs(level.peakDbfs - (-12.041199826559248)) < 0.0001);
  assert.ok(level.rmsDbfs < level.peakDbfs);
});
