import assert from 'node:assert/strict';
import test from 'node:test';

import { micPresenceDisplayValues } from '../shared/mic-presence-precision.js';
import { parseMicPresenceTelemetry } from '../src/mic-presence-telemetry.js';

test('Mic presence keeps display precision and nothing finer', () => {
  assert.deepEqual(
    micPresenceDisplayValues({
      rmsDbfs: -23.47281934712345,
      spectrumBands: [0.4123412341234123, 0.2987298729872987, 1, 0.0812081208120812, 0.0004],
      f0Hz: 221.83749283748273,
      pitchConfidence: 0.8734287342873428,
    }),
    {
      rmsDbfs: -23.5,
      spectrumBands: [0.412, 0.299, 1, 0.081, 0],
      f0Hz: 221.8,
      pitchConfidence: 0.87,
    },
  );
  assert.equal(
    micPresenceDisplayValues({ rmsDbfs: -40, spectrumBands: [0, 0, 0, 0, 0], f0Hz: null, pitchConfidence: 0 }).f0Hz,
    null,
    'no pitch stays no pitch',
  );
});

test('rounded Mic presence at the edges of its ranges is still valid telemetry', () => {
  const rounded = micPresenceDisplayValues({
    rmsDbfs: -0.04,
    spectrumBands: [0.99995, 0.00004, 1, 0, 0.5],
    f0Hz: 999.96,
    pitchConfidence: 0.999,
  });
  assert.ok(
    parseMicPresenceTelemetry({ version: 1, captureGeneration: 1, ...rounded }),
    `rounded values must still parse: ${JSON.stringify(rounded)}`,
  );
});
