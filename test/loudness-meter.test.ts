import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IntegratedLoudness,
  LoudnessMeter,
  kWeightingCoefficients,
  lufsFromMeanSquare,
} from '../shared/loudness-meter.js';

function tone(meter: LoudnessMeter, hz: number, dbfs: number, seconds: number, integrated?: IntegratedLoudness) {
  const amplitude = 10 ** (dbfs / 20);
  const total = Math.round(meter.sampleRate * seconds);
  for (let i = 0; i < total; i += 1) {
    const completed = meter.push(amplitude * Math.sin((2 * Math.PI * hz * i) / meter.sampleRate));
    if (completed) integrated?.add(meter.momentaryMeanSquare);
  }
}

function silence(meter: LoudnessMeter, seconds: number, integrated?: IntegratedLoudness) {
  const total = Math.round(meter.sampleRate * seconds);
  for (let i = 0; i < total; i += 1) {
    if (meter.push(0)) integrated?.add(meter.momentaryMeanSquare);
  }
}

test('derived K-weighting reproduces the BS.1770 48 kHz table', () => {
  const table = kWeightingCoefficients(48_000);
  // A rate one part in 1e9 off 48 kHz takes the derivation path, not the table.
  const derived = kWeightingCoefficients(48_000.000048);
  for (const stage of ['shelf', 'highPass'] as const) {
    for (const side of ['b', 'a'] as const) {
      table[stage][side].forEach((value, i) => {
        assert.ok(Math.abs(value - derived[stage][side][i]) < 1e-6, `${stage}.${side}[${i}]`);
      });
    }
  }
});

for (const sampleRate of [48_000, 44_100]) {
  test(`a 997 Hz sine at -20 dBFS reads -23.0 LUFS at ${sampleRate} Hz on every time scale`, () => {
    const meter = new LoudnessMeter(sampleRate);
    const integrated = new IntegratedLoudness();
    tone(meter, 997, -20, 4, integrated);
    for (const value of [meter.momentaryLufs, meter.shortTermLufs, integrated.lufs]) {
      assert.ok(value !== null && Math.abs(value - -23.01) < 0.05, String(value));
    }
  });
}

test('momentary and short-term wait for 400 ms and 3 s of audio', () => {
  const meter = new LoudnessMeter();
  tone(meter, 997, -20, 0.39);
  assert.equal(meter.momentaryLufs, null);
  tone(meter, 997, -20, 0.02);
  assert.notEqual(meter.momentaryLufs, null);
  assert.equal(meter.shortTermLufs, null);
  tone(meter, 997, -20, 2.6);
  assert.notEqual(meter.shortTermLufs, null);
});

test('a block completes every 100 ms', () => {
  const meter = new LoudnessMeter(48_000);
  let completed = 0;
  for (let i = 0; i < 48_000; i += 1) if (meter.push(0.1)) completed += 1;
  assert.equal(completed, 10);
});

test('K-weighting hears presence frequencies louder and bass quieter than 1 kHz', () => {
  const read = (hz: number) => {
    const meter = new LoudnessMeter();
    tone(meter, hz, -20, 1);
    return meter.momentaryLufs!;
  };
  const reference = read(997);
  assert.ok(read(4_000) - reference > 3, 'the head shelf lifts 4 kHz by about 4 dB');
  assert.ok(read(30) - reference < -1, 'the high pass discounts 30 Hz');
});

test('silence reads -Infinity, never NaN, and reset forgets history', () => {
  const meter = new LoudnessMeter();
  silence(meter, 0.5);
  assert.equal(meter.momentaryLufs, -Infinity);
  assert.equal(lufsFromMeanSquare(0), -Infinity);
  tone(meter, 997, -20, 0.5);
  meter.reset();
  assert.equal(meter.momentaryLufs, null);
});

test('integrated loudness gates out silence and passages 10 LU under the rest', () => {
  const meter = new LoudnessMeter();
  const integrated = new IntegratedLoudness();
  tone(meter, 997, -20, 10, integrated);
  silence(meter, 10, integrated);
  tone(meter, 997, -40, 10, integrated);
  assert.ok(Math.abs(integrated.lufs! - -23.01) < 0.3, String(integrated.lufs));

  const empty = new IntegratedLoudness();
  empty.add(0);
  assert.equal(empty.lufs, null);
});
