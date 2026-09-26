import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';

const RATE = 48_000;
const SOURCE_RATE = 44_100;
const SOURCE_CHUNK = 882;

function makeSession() {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 1,
    retentionMs: 5_000,
  });
  session.start(0);
  return session;
}

function pcmOf(values: number[]) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
}

/** Feeds `source` as contiguous 20 ms 44.1 kHz Mic packets; returns the 48 kHz timeline. */
function upsample(source: number[]) {
  const session = makeSession();
  let emitted = 0;
  for (let start = 0; start < source.length; start += SOURCE_CHUNK) {
    const result = session.ingestMic(
      { generation: 1, firstSampleIndex: start, pcm: pcmOf(source.slice(start, start + SOURCE_CHUNK)) },
      SOURCE_RATE,
      1_000 + (start / SOURCE_RATE) * 1_000,
    );
    if (start === 0) emitted = result.start;
  }
  return session.readMic(emitted, session.micTotalSamples - emitted);
}

function rms(values: ArrayLike<number>, from: number, to: number) {
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += values[index]! ** 2;
  return Math.sqrt(sum / (to - from));
}

test('44.1 kHz Mic upsampling keeps the top octave', () => {
  // Linear interpolation lost 1.5 dB of a 10 kHz tone and 3.1 dB at 15 kHz;
  // the cubic keeps them within 0.4 and 1.5 dB.
  for (const [frequencyHz, floorDb] of [[1_000, -0.05], [10_000, -0.5], [15_000, -1.7]] as const) {
    const source = Array.from({ length: SOURCE_RATE }, (_, index) => (
      Math.round(20_000 * Math.sin((2 * Math.PI * frequencyHz * index) / SOURCE_RATE))
    ));
    const output = upsample(source);
    const lossDb = 20 * Math.log10(
      rms(output, 200, output.length - 200) / rms(source, 200, source.length - 200),
    );
    assert.ok(lossDb > floorDb, `${frequencyHz} Hz lost ${lossDb.toFixed(2)} dB`);
  }
});

test('a cubic overshoot at full scale is clamped, never wrapped to the other rail', () => {
  // -FS, +FS, +FS, -FS: the cubic between the two +FS samples overshoots +FS.
  const cycle = [-32_768, 32_767, 32_767, -32_768];
  const source = Array.from({ length: SOURCE_CHUNK * 4 }, (_, index) => cycle[index % 4]!);
  const output = upsample(source);
  let largest = -Infinity;
  for (let index = 0; index < output.length; index += 1) {
    largest = Math.max(largest, output[index]!);
    if (index > 0) {
      assert.ok(
        Math.abs(output[index]! - output[index - 1]!) < 65_535,
        `a wrapped sample jumped rail to rail at ${index}`,
      );
    }
  }
  assert.equal(largest, 32_767);
});
