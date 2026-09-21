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

function loadCaptureProcessor(workletSampleRate = 48_000) {
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
      sampleRate: workletSampleRate,
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

test('capture worklet de-clicks a local input gap across a flushed PCM boundary', async () => {
  const processor = await loadCaptureProcessor();
  enablePcmEnvelope(processor);

  // Flush one complete real-audio chunk first. The gap therefore begins after
  // the previous PCM has already left the worklet and cannot be edited in place.
  processor.process([[new Float32Array(960).fill(0.5)]]);
  processor.process([]);
  processor.process([[new Float32Array(832).fill(0.5)]]);

  const pcm = processor.port.messages.filter((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: string }).type === 'pcm'
  )) as PcmMessage[];
  assert.equal(pcm.length, 2);

  const previous = new Int16Array(pcm[0].buffer);
  const recovered = new Int16Array(pcm[1].buffer);
  const full = previous[previous.length - 1];
  const fadeSamples = Math.round(48_000 * 0.002);

  assert.ok(
    Math.abs(recovered[0] - full) <= 1,
    'the first missing sample continues the already-flushed waveform instead of stepping to zero',
  );
  assert.equal(recovered[fadeSamples - 1], 0, 'the synthetic gap edge reaches silence within 2 ms');
  assert.ok(
    recovered.slice(fadeSamples, 128).every((sample) => sample === 0),
    'the remainder of the missing render quantum stays literal silence',
  );

  assert.equal(recovered[128], 0, 'recovered real input fades in from silence');
  assert.ok(
    Math.abs(recovered[128 + fadeSamples - 1] - full) <= 1,
    'the recovered input reaches its original level within 2 ms',
  );
  assert.ok(
    recovered.slice(128 + fadeSamples).every((sample) => Math.abs(sample - full) <= 1),
    'real input outside the bounded recovery edge stays untouched',
  );

  let maximumEdgeStep = 0;
  for (let index = 1; index < fadeSamples; index += 1) {
    maximumEdgeStep = Math.max(
      maximumEdgeStep,
      Math.abs(recovered[index] - recovered[index - 1]),
      Math.abs(recovered[128 + index] - recovered[128 + index - 1]),
    );
  }
  assert.ok(maximumEdgeStep < 250, `de-click edge stepped by ${maximumEdgeStep} PCM counts`);

  const gap = processor.port.messages.find((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: string }).type === 'input-gap'
  )) as { samples?: number; recovered?: boolean } | undefined;
  assert.deepEqual(
    { samples: gap?.samples, recovered: gap?.recovered },
    { samples: 128, recovered: true },
    'audio tapering must not shrink or hide the raw missing-input evidence',
  );

  const level = latestLevel(processor);
  assert.ok(level);
  const expectedRms = 0.5 * Math.sqrt(832 / 960);
  assert.ok(
    Math.abs(level.rmsDbfs - (20 * Math.log10(expectedRms))) < 0.0001,
    'level evidence must describe raw recovered input plus the real missing silence, not the synthetic taper',
  );
});

test('capture worklet keeps a sub-2 ms high-rate input gap continuous on recovery', async () => {
  const processor = await loadCaptureProcessor(96_000);
  enablePcmEnvelope(processor);

  processor.process([[new Float32Array(1_920).fill(0.5)]]);
  processor.process([]);
  processor.process([[new Float32Array(1_792).fill(0.5)]]);

  const pcm = processor.port.messages.filter((message) => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: string }).type === 'pcm'
  )) as PcmMessage[];
  assert.equal(pcm.length, 2);

  const previous = new Int16Array(pcm[0].buffer);
  const next = new Int16Array(pcm[1].buffer);
  const gapSamples = 128;
  const fadeSamples = Math.round(96_000 * 0.002);

  assert.ok(
    Math.abs(next[0] - previous[previous.length - 1]) <= 1,
    'the short high-rate gap must begin continuously',
  );
  assert.notEqual(
    next[gapSamples - 1],
    0,
    'a 1.33 ms gap at 96 kHz ends before a 2 ms fade can reach zero',
  );
  assert.ok(
    Math.abs(next[gapSamples] - next[gapSamples - 1]) < 250,
    'recovery must continue from the partially faded edge instead of jumping to zero',
  );
  assert.ok(
    Math.abs(next[gapSamples + fadeSamples - 1] - previous[previous.length - 1]) <= 1,
    'recovery crossfade returns to the real waveform over the bounded 2 ms window',
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
