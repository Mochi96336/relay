import assert from 'node:assert/strict';
import test from 'node:test';

import { loadBackingConfig, loadRelayConfig } from '../src/config.js';
import { startRelay } from './helpers/harness.js';

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

test('relay config owns the participant and mic transport grace windows', () => {
  assert.throws(() => loadRelayConfig({ RELAY_PARTICIPANT_GRACE_MS: '0' }), />= 1/);
  assert.throws(
    () => loadRelayConfig({ RELAY_MIC_TRANSPORT_GRACE_MS: 'soon' }),
    /RELAY_MIC_TRANSPORT_GRACE_MS must be a finite number/,
  );

  const config = loadRelayConfig({
    RELAY_PARTICIPANT_GRACE_MS: '7500',
    RELAY_MIC_TRANSPORT_GRACE_MS: '2500',
  });
  assert.equal(config.participantGraceMs, 7_500);
  assert.equal(config.micTransportGraceMs, 2_500);
});

test('real server entry fails closed on malformed deployment config', async () => {
  await assert.rejects(
    startRelay({ RELAY_CALIBRATION_PROBE_MIN_CORRELATION: 'oops' }),
    /RELAY_CALIBRATION_PROBE_MIN_CORRELATION must be a finite number/,
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

test('backing config validates its URL, identity and transport ranges before capture starts', () => {
  assert.throws(() => loadBackingConfig({ RELAY_URL: 'https://example.test/ws' }), /must use ws:\/\/ or wss:\/\//);
  assert.throws(() => loadBackingConfig({ RELAY_URL: 'ws://127.0.0.1:0/ws' }), /port must be from 1 to 65535/);
  assert.throws(() => loadBackingConfig({ PORT: '0' }), /PORT must be from 1 to 65535/);
  assert.throws(() => loadBackingConfig({ RELAY_BACKING_RECONNECT_MS: '10' }), />= 50/);
  assert.throws(
    () => loadBackingConfig({ RELAY_BACKING_ROBOT: 'robot-ish' }),
    /RELAY_BACKING_ROBOT must be one of: 1, 0, true, false/,
  );

  // An explicit endpoint owns the destination completely. A stale PORT value
  // must not make the backing process fail when it is not used to build the URL.
  assert.equal(
    loadBackingConfig({ RELAY_URL: 'ws://relay.test:3100/ws', PORT: 'not-used' }).relayUrl,
    'ws://relay.test:3100/ws',
  );
  assert.equal(loadBackingConfig({ RELAY_BACKING_ROBOT: '1' }).robot, true);
  assert.equal(loadBackingConfig({ RELAY_BACKING_ROBOT: 'false' }).robot, false);

  const config = loadBackingConfig({
    PORT: '3100',
    RELAY_KEY: 'sekrit',
    RELAY_BACKING_SAMPLE_RATE: '44100',
  });
  assert.equal(config.sampleRate, 44_100);
  assert.equal(config.robot, false);
  assert.equal(config.relayUrl, 'ws://127.0.0.1:3100/ws?key=sekrit');
});
