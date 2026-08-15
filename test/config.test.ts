import assert from 'node:assert/strict';
import test from 'node:test';

import { loadBackingConfig, loadRelayConfig } from '../src/config.js';

test('relay config rejects malformed numeric deployment settings', () => {
  assert.throws(
    () => loadRelayConfig({ RELAY_CALIBRATION_PROBE_MIN_CORRELATION: 'oops' }),
    /RELAY_CALIBRATION_PROBE_MIN_CORRELATION must be a finite number/,
  );
  assert.throws(
    () => loadRelayConfig({ RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '1.2' }),
    /from 0 to 1/,
  );
  assert.throws(
    () => loadRelayConfig({ RELAY_CALIBRATION_AGREEMENT: '2.5' }),
    /must be an integer/,
  );
});

test('relay config accepts explicit boolean spellings and rejects guesses', () => {
  assert.equal(loadRelayConfig({ RELAY_AUTO_CALIBRATE: '0' }).autoCalibrate, false);
  assert.equal(loadRelayConfig({ RELAY_AUTO_CALIBRATE: 'false' }).autoCalibrate, false);
  assert.equal(loadRelayConfig({ RELAY_AUTO_CALIBRATE: '1' }).autoCalibrate, true);
  assert.throws(
    () => loadRelayConfig({ RELAY_AUTO_CALIBRATE: 'disabled' }),
    /must be one of: 1, 0, true, false/,
  );
});

test('backing config validates its URL and transport ranges before capture starts', () => {
  assert.throws(() => loadBackingConfig({ RELAY_URL: 'https://example.test/ws' }), /must use ws:\/\/ or wss:\/\//);
  assert.throws(() => loadBackingConfig({ RELAY_BACKING_RECONNECT_MS: '10' }), />= 50/);

  const config = loadBackingConfig({
    PORT: '3100',
    RELAY_KEY: 'sekrit',
    RELAY_BACKING_SAMPLE_RATE: '44100',
  });
  assert.equal(config.sampleRate, 44_100);
  assert.equal(config.relayUrl, 'ws://127.0.0.1:3100/ws?key=sekrit');
});
