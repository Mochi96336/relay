import assert from 'node:assert/strict';
import test from 'node:test';

import { createStreamingLinearResampler } from '../public/streaming-linear-resampler.js';

function concatFloat32(...parts: Float32Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function maximumDifference(a: Float32Array, b: Float32Array) {
  assert.equal(a.length, b.length);
  let maximum = 0;
  for (let index = 0; index < a.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(a[index] - b[index]));
  }
  return maximum;
}

function tone(length: number, sampleRate: number, frequencyHz = 8_000) {
  return Float32Array.from({ length }, (_, index) => (
    0.8 * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate)
  ));
}

test('same-rate Listen PCM bypasses the resampler exactly', () => {
  const resampler = createStreamingLinearResampler();
  const input = tone(960, 48_000, 997);
  const output = resampler.resample(input, {
    sourceRate: 48_000,
    targetRate: 48_000,
    firstSampleIndex: 12_480,
  });

  assert.equal(output, input);
});

test('48 to 96 kHz Listen resampling is independent of 20 ms monitor frame boundaries', () => {
  const sourceRate = 48_000;
  const targetRate = 96_000;
  const frameSamples = 960;
  const input = tone(frameSamples * 2, sourceRate);

  const wholeResampler = createStreamingLinearResampler();
  const whole = wholeResampler.resample(input, {
    sourceRate,
    targetRate,
    firstSampleIndex: 0,
  });

  const framedResampler = createStreamingLinearResampler();
  const first = framedResampler.resample(input.slice(0, frameSamples), {
    sourceRate,
    targetRate,
    firstSampleIndex: 0,
  });
  const second = framedResampler.resample(input.slice(frameSamples), {
    sourceRate,
    targetRate,
    firstSampleIndex: frameSamples,
  });
  const framed = concatFloat32(first, second);

  assert.equal(first.length, 1_920);
  assert.equal(second.length, 1_920);
  assert.equal(framed.length, 3_840);
  assert.ok(
    maximumDifference(whole, framed) < 1e-7,
    '20 ms packetization must not reset interpolation phase or hold the packet tail',
  );

  const boundaryTarget = 1_920;
  assert.ok(
    Math.abs(framed[boundaryTarget] - input[959]) < 1e-7,
    'the first target in frame two uses the previous frame tail on the causal clock',
  );
  assert.ok(
    Math.abs(framed[boundaryTarget + 1] - ((input[959] + input[960]) / 2)) < 1e-7,
    'the next target interpolates the previous tail into the current frame head',
  );
});

test('48 to 44.1 kHz Listen resampling keeps exact packetization parity', () => {
  const sourceRate = 48_000;
  const targetRate = 44_100;
  const frameSamples = 960;
  const input = tone(frameSamples * 2, sourceRate, 6_100);

  const wholeResampler = createStreamingLinearResampler();
  const whole = wholeResampler.resample(input, {
    sourceRate,
    targetRate,
    firstSampleIndex: 0,
  });

  const framedResampler = createStreamingLinearResampler();
  const framed = concatFloat32(
    framedResampler.resample(input.slice(0, frameSamples), {
      sourceRate,
      targetRate,
      firstSampleIndex: 0,
    }),
    framedResampler.resample(input.slice(frameSamples), {
      sourceRate,
      targetRate,
      firstSampleIndex: frameSamples,
    }),
  );

  assert.equal(framed.length, 1_764);
  assert.ok(maximumDifference(whole, framed) < 1e-7);
});

test('Listen streaming resampling never interpolates across a real monitor gap', () => {
  const resampler = createStreamingLinearResampler();

  resampler.resample(new Float32Array(960).fill(0.75), {
    sourceRate: 48_000,
    targetRate: 96_000,
    firstSampleIndex: 0,
  });

  // Skip a complete 20 ms source frame. The resampler must self-fence even if
  // a caller forgets to reset it explicitly.
  const recovered = resampler.resample(new Float32Array(960).fill(-0.75), {
    sourceRate: 48_000,
    targetRate: 96_000,
    firstSampleIndex: 1_920,
  });

  assert.equal(recovered.length, 1_920);
  assert.ok(
    recovered.slice(0, 16).every((sample) => Math.abs(sample + 0.75) < 1e-7),
    'recovered PCM must not blend with a pre-gap tail',
  );
});

test('explicit resampler reset fences an otherwise contiguous source frame', () => {
  const resampler = createStreamingLinearResampler();
  resampler.resample(new Float32Array(960).fill(0.5), {
    sourceRate: 48_000,
    targetRate: 96_000,
    firstSampleIndex: 0,
  });

  resampler.reset();
  const recovered = resampler.resample(new Float32Array(960).fill(-0.5), {
    sourceRate: 48_000,
    targetRate: 96_000,
    firstSampleIndex: 960,
  });

  assert.ok(
    recovered.slice(0, 16).every((sample) => Math.abs(sample + 0.5) < 1e-7),
    'generation/timeline reset must not reuse the previous source tail',
  );
});
