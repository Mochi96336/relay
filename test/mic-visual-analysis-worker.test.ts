import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type AnalysisMessage = {
  type: 'analysis';
  spectrumBands: number[];
  f0Hz: number | null;
  pitchConfidence: number;
};

async function loadAnalysisWorker(sampleRate = 48_000) {
  const source = await readFile(path.resolve('public/mic-visual-analysis-worker.js'), 'utf8');
  const messages: AnalysisMessage[] = [];
  const self = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: AnalysisMessage) => messages.push(message),
  };

  vm.runInNewContext(source, {
    self,
    ArrayBuffer,
    Int16Array,
    Float32Array,
    Math,
    Number,
    Object,
  });

  if (!self.onmessage) throw new Error('analysis worker did not register onmessage');
  self.onmessage({ data: { type: 'configure', sampleRate } });
  return {
    source,
    messages,
    push(buffer: ArrayBuffer) {
      self.onmessage!({ data: { type: 'pcm', buffer } });
      return messages.at(-1);
    },
  };
}

function pcmFromFloat(samples: Float32Array) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
  }
  return pcm.buffer;
}

function sine(frequencyHz: number, durationMs = 120, amplitude = 0.4) {
  const length = Math.round((48_000 * durationMs) / 1000);
  return Float32Array.from({ length }, (_, index) => (
    Math.sin((2 * Math.PI * frequencyHz * index) / 48_000) * amplitude
  ));
}

function chunks(samples: Float32Array, size = 960) {
  const output: ArrayBuffer[] = [];
  for (let offset = 0; offset < samples.length; offset += size) {
    output.push(pcmFromFloat(samples.subarray(offset, Math.min(samples.length, offset + size))));
  }
  return output;
}

test('visual analysis Worker owns FFT and YIN instead of the realtime AudioWorklet', async () => {
  const worker = await loadAnalysisWorker();
  assert.match(worker.source, /SPECTRUM_FFT_SIZE = 512/);
  assert.match(worker.source, /F0_YIN_THRESHOLD = 0\.18/);
  assert.match(worker.source, /function runFft\(\)/);
  assert.match(worker.source, /function measureF0\(rms\)/);
});

test('visual spectrum remains frequency-shape evidence, separate from pitch', async () => {
  const lowWorker = await loadAnalysisWorker();
  const low = lowWorker.push(pcmFromFloat(sine(187.5, 20)))!;
  assert.ok(low.spectrumBands[0] > low.spectrumBands[4]);

  const highWorker = await loadAnalysisWorker();
  const high = highWorker.push(pcmFromFloat(sine(3000, 20)))!;
  assert.ok(high.spectrumBands[4] > high.spectrumBands[0]);
});

for (const frequencyHz of [100, 220, 440]) {
  test(`visual Worker F0 detector tracks a ${frequencyHz} Hz sine`, async () => {
    const worker = await loadAnalysisWorker();
    let analysis: AnalysisMessage | undefined;
    for (const chunk of chunks(sine(frequencyHz))) {
      analysis = worker.push(chunk);
    }
    assert.ok(analysis);
    assert.ok(analysis.f0Hz !== null);
    assert.ok(
      Math.abs(analysis.f0Hz - frequencyHz) < 2,
      `expected ~${frequencyHz} Hz, got ${analysis.f0Hz}`,
    );
    assert.ok(analysis.pitchConfidence >= 0.8);
  });
}

test('visual Worker returns null pitch for silence and low confidence for noise', async () => {
  const silence = await loadAnalysisWorker();
  let silentAnalysis: AnalysisMessage | undefined;
  for (const chunk of chunks(new Float32Array(5_760))) {
    silentAnalysis = silence.push(chunk);
  }
  assert.ok(silentAnalysis);
  assert.equal(silentAnalysis.f0Hz, null);
  assert.equal(silentAnalysis.pitchConfidence, 0);

  const noiseWorker = await loadAnalysisWorker();
  const random = new Float32Array(5_760);
  let state = 0x1234_5678;
  for (let index = 0; index < random.length; index += 1) {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    random[index] = ((state / 0x1_0000_0000) * 2 - 1) * 0.4;
  }

  let noiseAnalysis: AnalysisMessage | undefined;
  for (const chunk of chunks(random)) {
    noiseAnalysis = noiseWorker.push(chunk);
  }
  assert.ok(noiseAnalysis);
  assert.equal(noiseAnalysis.f0Hz, null);
  assert.ok(noiseAnalysis.pitchConfidence < 0.6);
});

test('visual Worker prefers the fundamental in a harmonic-rich singing signal', async () => {
  const worker = await loadAnalysisWorker();
  const fundamentalHz = 110;
  const input = Float32Array.from({ length: 5_760 }, (_, index) => {
    const phase = (2 * Math.PI * fundamentalHz * index) / 48_000;
    return 0.12 * Math.sin(phase) + 0.35 * Math.sin(phase * 2) + 0.2 * Math.sin(phase * 3);
  });

  let analysis: AnalysisMessage | undefined;
  for (const chunk of chunks(input)) {
    analysis = worker.push(chunk);
  }
  assert.ok(analysis);
  assert.ok(analysis.f0Hz !== null);
  assert.ok(
    Math.abs(analysis.f0Hz - fundamentalHz) < 2,
    `expected ~110 Hz, got ${analysis.f0Hz}`,
  );
});
