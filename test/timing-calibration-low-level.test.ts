import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeTimingCalibration } from '../src/timing-calibration.js';
import { analyzeTimingCalibrationInWorker } from '../src/timing-calibration-worker-client.js';
import {
  laggedMultibandMusicPair,
  sameBpmDifferentMusicPair,
} from './helpers/music-calibration.js';

const RATE = 48_000;
const KNOWN_LAG_MS = 285;
const SAFE_MATCHER_REJECTION = /weak|does not match|repetitive|frequency-band support|coarse timing peak|Timing moved/i;

function int16View(buffer: Buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
}

function levelDbfs(samples: Int16Array) {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] / 32768;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

function scaleToDbfs(buffer: Buffer, targetDbfs: number) {
  const input = int16View(buffer);
  const currentDbfs = levelDbfs(input);
  const gain = 10 ** ((targetDbfs - currentDbfs) / 20);
  const output = Buffer.alloc(buffer.byteLength);
  for (let i = 0; i < input.length; i += 1) {
    const scaled = Math.max(-32768, Math.min(32767, Math.round(input[i] * gain)));
    output.writeInt16LE(scaled, i * 2);
  }
  return output;
}

function deterministicNoise(bytes: number, targetDbfs: number, seed: number) {
  const samples = bytes / 2;
  const output = Buffer.alloc(bytes);
  let state = seed >>> 0;
  const targetRms = 10 ** (targetDbfs / 20);
  const peak = targetRms * Math.sqrt(3);
  for (let i = 0; i < samples; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const unit = (state / 0xffffffff) * 2 - 1;
    const value = Math.max(-1, Math.min(1, unit * peak));
    output.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), i * 2);
  }
  return output;
}

function mixPcm(a: Buffer, b: Buffer) {
  assert.equal(a.byteLength, b.byteLength);
  const output = Buffer.alloc(a.byteLength);
  for (let offset = 0; offset < a.byteLength; offset += 2) {
    const mixed = Math.max(-32768, Math.min(32767, a.readInt16LE(offset) + b.readInt16LE(offset)));
    output.writeInt16LE(mixed, offset);
  }
  return output;
}

test('authoritative matcher accepts genuine evidence below the former -60 dBFS mic floor', () => {
  for (const targetDbfs of [-61, -64]) {
    const pair = laggedMultibandMusicPair(6, RATE, KNOWN_LAG_MS);
    const mic = scaleToDbfs(pair.mic, targetDbfs);
    const result = analyzeTimingCalibration(int16View(mic), int16View(pair.backing), RATE, 2_500);

    assert.ok(
      Math.abs(result.micLevelDbfs - targetDbfs) <= 0.5,
      `target ${targetDbfs} dBFS measured ${result.micLevelDbfs.toFixed(1)} dBFS`,
    );
    assert.ok(
      Math.abs(result.micLagMs - KNOWN_LAG_MS) <= 25,
      `${targetDbfs} dBFS returned ${result.micLagMs} ms`,
    );
    assert.ok(result.diagnostics.activeBands.length >= 3);
    assert.ok(result.diagnostics.supportingBands.length >= 3);
  }
});

test('low-level wrong content is still rejected by matcher quality gates', () => {
  const pair = sameBpmDifferentMusicPair(6, RATE);
  const mic = scaleToDbfs(pair.mic, -64);

  assert.throws(
    () => analyzeTimingCalibration(int16View(mic), int16View(pair.backing), RATE, 2_500),
    /weak|does not match|repetitive|support/i,
  );
});

test('direct backing capture keeps its dead-route level guard', () => {
  const pair = laggedMultibandMusicPair(6, RATE, KNOWN_LAG_MS);
  const quietBacking = scaleToDbfs(pair.backing, -55);

  assert.throws(
    () => analyzeTimingCalibration(int16View(pair.mic), int16View(quietBacking), RATE, 2_500),
    /Desktop source is too quiet/i,
  );
});

test('worker resolves genuine low-level mic evidence through the authoritative path', async () => {
  const pair = laggedMultibandMusicPair(6, RATE, KNOWN_LAG_MS);
  const mic = scaleToDbfs(pair.mic, -64);

  const result = await analyzeTimingCalibrationInWorker(
    int16View(mic),
    int16View(pair.backing),
    RATE,
    2_500,
  );

  assert.ok(Math.abs(result.micLagMs - KNOWN_LAG_MS) <= 25);
  assert.ok(result.micLevelDbfs < -60);
});

test('room noise above the former floor never turns weak bleed into a wrong authoritative lag', () => {
  for (const bleedDbfs of [-64, -70]) {
    const pair = laggedMultibandMusicPair(6, RATE, KNOWN_LAG_MS);
    const bleed = scaleToDbfs(pair.mic, bleedDbfs);
    const roomNoise = deterministicNoise(bleed.byteLength, -50, 0x96336 + Math.abs(bleedDbfs));
    const noisyMic = mixPcm(bleed, roomNoise);
    assert.ok(levelDbfs(int16View(noisyMic)) > -60, 'room noise must dominate the removed RMS gate');

    let result: ReturnType<typeof analyzeTimingCalibration> | null = null;
    let failure: unknown = null;
    try {
      result = analyzeTimingCalibration(int16View(noisyMic), int16View(pair.backing), RATE, 2_500);
    } catch (error) {
      failure = error;
    }

    if (result !== null) {
      assert.ok(
        Math.abs(result.micLagMs - KNOWN_LAG_MS) <= 25,
        `${bleedDbfs} dBFS bleed plus -50 dBFS room noise produced wrong lag ${result.micLagMs} ms`,
      );
      continue;
    }

    assert.ok(failure instanceof Error, 'rejected noisy evidence must expose a matcher failure');
    assert.match(failure.message, SAFE_MATCHER_REJECTION);
  }
});
