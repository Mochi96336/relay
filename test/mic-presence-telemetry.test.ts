import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMicPresenceTelemetry } from '../src/mic-presence-telemetry.js';

function validTelemetry() {
  return {
    type: 'mic-presence-telemetry',
    version: 1,
    captureGeneration: 42,
    rmsDbfs: -31.5,
    spectrumBands: [0.12, 0.48, 1, 0.37, 0.08],
  };
}

test('room Mic presence accepts one generation-bound RMS plus five normalized bands', () => {
  assert.deepEqual(parseMicPresenceTelemetry(validTelemetry()), {
    version: 1,
    captureGeneration: 42,
    rmsDbfs: -31.5,
    spectrumBands: [0.12, 0.48, 1, 0.37, 0.08],
  });
});

test('room Mic presence rejects malformed or unbounded display evidence', () => {
  assert.equal(parseMicPresenceTelemetry(null), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), version: 2 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), captureGeneration: -1 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), rmsDbfs: 3 }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), spectrumBands: [0, 1] }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), spectrumBands: [0, 0.5, 1.2, 0.3, 0] }), null);
  assert.equal(parseMicPresenceTelemetry({ ...validTelemetry(), spectrumBands: [0, Number.NaN, 1, 0.3, 0] }), null);
});
