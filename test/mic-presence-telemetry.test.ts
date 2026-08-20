import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMicPresenceTelemetry } from '../src/mic-presence-telemetry.js';

function validTelemetry() {
  return {
    type: 'mic-presence-telemetry',
    version: 1,
    captureGeneration: 23,
    rmsDbfs: -31.5,
    spectrumBands: [0.12, 0.48, 1, 0.37, 0.08],
    f0Hz: 220.4,
    pitchConfidence: 0.91,
  };
}

test('room Mic presence accepts bounded RMS, spectrum and real F0 evidence for one capture generation', () => {
  assert.deepEqual(parseMicPresenceTelemetry(validTelemetry()), {
    version: 1,
    captureGeneration: 23,
    rmsDbfs: -31.5,
    spectrumBands: [0.12, 0.48, 1, 0.37, 0.08],
    f0Hz: 220.4,
    pitchConfidence: 0.91,
  });
  assert.equal(parseMicPresenceTelemetry({
    ...validTelemetry(),
    f0Hz: null,
    pitchConfidence: 0.17,
  })?.f0Hz, null);
});

test('room Mic presence rejects malformed generation or unbounded display evidence', () => {
  assert.equal(parseMicPresenceTelemetry(null), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), version: 2 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), captureGeneration: -1 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), captureGeneration: 2 ** 32 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), rmsDbfs: 3 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), spectrumBands: [0, 1] }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), spectrumBands: [0, 0.5, 1.2, 0.3, 0] }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), f0Hz: 60 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), f0Hz: 1200 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), pitchConfidence: 1.2 }), null);
});
