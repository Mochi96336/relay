import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { combineBootCalibration, legLatencyMs } from '../src/boot-calibration.js';

const RATE = 48_000;

const ms = (value: number) => Math.round((RATE * value) / 1000);

function leg(targetMs: number, actualMs: number, correlation = 0.8) {
  return { targetSample: ms(targetMs), actualSample: ms(actualMs), correlation };
}

describe('boot calibration arithmetic', () => {
  test('a timeline that stores audio late reports a positive latency', () => {
    // Played at 1000 ms, found at 1300 ms: the timeline puts it 300 ms later
    // than it happened, which is what capture and uplink buffering do.
    assert.equal(legLatencyMs(leg(1000, 1300), RATE), 300);
  });

  test('the mixer reads the microphone ahead when it lags the song', () => {
    // Mic stores 500 ms late, backing 100 ms late, players agree. The mic
    // sample at position s is 400 ms older than the song at s, so the mixer
    // has to read 400 ms further along to find the contemporaneous vocal.
    const result = combineBootCalibration({
      mic: leg(1000, 1500),
      backing: leg(1000, 1100),
      deltaMs: 0,
      sampleRate: RATE,
    });

    assert.equal(result.micLatencyMs, 500);
    assert.equal(result.backingLatencyMs, 100);
    assert.equal(result.advanceMs, 400);
  });

  test('a robot running ahead of the phone adds to the advance', () => {
    // The singer hears the phone. If the robot is 100 ms ahead, the song in
    // the backing timeline is 100 ms further on than what was sung against,
    // so the matching vocal is 100 ms further along too.
    const behind = combineBootCalibration({
      mic: leg(1000, 1500), backing: leg(1000, 1100), deltaMs: 0, sampleRate: RATE,
    });
    const ahead = combineBootCalibration({
      mic: leg(1000, 1500), backing: leg(1000, 1100), deltaMs: 100, sampleRate: RATE,
    });

    assert.equal(ahead.advanceMs - behind.advanceMs, 100);
  });

  test('a robot running behind the phone subtracts from it', () => {
    const result = combineBootCalibration({
      mic: leg(1000, 1500), backing: leg(1000, 1100), deltaMs: -250, sampleRate: RATE,
    });
    assert.equal(result.advanceMs, 150);
  });

  test('identical paths with aligned players need no correction', () => {
    const result = combineBootCalibration({
      mic: leg(1000, 1200), backing: leg(1000, 1200), deltaMs: 0, sampleRate: RATE,
    });
    assert.equal(result.advanceMs, 0);
  });

  test('reproduces the deployment that measured about -1.8 s by content correlation', () => {
    // The robot take that the recording confirmed: the vocal sat nearly two
    // seconds out. A backing path far slower than the microphone's produces
    // exactly that sign and size, and nothing about it is a beat alias.
    const result = combineBootCalibration({
      mic: leg(1000, 1150),
      backing: leg(1000, 2900),
      deltaMs: -40,
      sampleRate: RATE,
    });

    assert.equal(result.micLatencyMs, 150);
    assert.equal(result.backingLatencyMs, 1900);
    assert.equal(result.advanceMs, -1790);
  });

  test('is worth no more than its weakest leg', () => {
    const result = combineBootCalibration({
      mic: leg(1000, 1150, 0.9),
      backing: leg(1000, 1150, 0.55),
      deltaMs: 0,
      sampleRate: RATE,
    });
    assert.equal(result.confidence, 0.55);
  });
});
