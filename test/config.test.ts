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

test('relay config owns remaining server-local deployment inputs', () => {
  const defaults = loadRelayConfig({});
  assert.equal(defaults.takeDir, 'takes');
  assert.equal(defaults.infrastructureKey, null);
  assert.equal(defaults.legacyTestInfrastructure, false);
  assert.equal(defaults.monitorBacklogMs, 200);
  assert.equal(defaults.micFirstFrameTimeoutMs, 3_000);
  assert.equal(defaults.probeReplyTimeoutMs, 3_000);
  assert.equal(defaults.probeMaxAttempts, 3);
  assert.equal(defaults.robotOffsetWindowMs, 2_000);
  assert.equal(defaults.robotContentTransitionLifetimeMs, 15_000);
  assert.equal(defaults.robotContentTransitionMaxWindows, 12);
  assert.equal(defaults.robotContentTransitionMaxWorkerFailures, 3);

  const infrastructureKey = 'a'.repeat(64);
  const configured = loadRelayConfig({
    RELAY_TAKE_DIR: './custom-takes',
    RELAY_INFRA_KEY: infrastructureKey,
    NODE_ENV: 'test',
    RELAY_TEST_LEGACY_INFRASTRUCTURE: '1',
    RELAY_MONITOR_BACKLOG_MS: '350',
    RELAY_MIC_FIRST_FRAME_TIMEOUT_MS: '4500',
    RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '4200',
    RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '5',
    RELAY_ROBOT_OFFSET_WINDOW_MS: '2750',
    RELAY_ROBOT_CONTENT_TRANSITION_LIFETIME_MS: '18000',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WINDOWS: '15',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES: '4',
  });
  assert.equal(configured.takeDir, './custom-takes');
  assert.equal(configured.infrastructureKey, infrastructureKey);
  assert.equal(configured.legacyTestInfrastructure, true);
  assert.equal(configured.monitorBacklogMs, 350);
  assert.equal(configured.micFirstFrameTimeoutMs, 4_500);
  assert.equal(configured.probeReplyTimeoutMs, 4_200);
  assert.equal(configured.probeMaxAttempts, 5);
  assert.equal(configured.robotOffsetWindowMs, 2_750);
  assert.equal(configured.robotContentTransitionLifetimeMs, 18_000);
  assert.equal(configured.robotContentTransitionMaxWindows, 15);
  assert.equal(configured.robotContentTransitionMaxWorkerFailures, 4);

  // These fields historically fell back instead of failing deployment parsing.
  // Preserve that behavior while moving ownership out of server.ts.
  const legacyFallbacks = loadRelayConfig({
    RELAY_MONITOR_BACKLOG_MS: 'nope',
    RELAY_MIC_FIRST_FRAME_TIMEOUT_MS: '0',
    RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '-1',
    RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '2.5',
    RELAY_ROBOT_OFFSET_WINDOW_MS: 'Infinity',
    RELAY_ROBOT_CONTENT_TRANSITION_LIFETIME_MS: '',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WINDOWS: '0',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES: 'NaN',
  });
  assert.equal(legacyFallbacks.monitorBacklogMs, 200);
  assert.equal(legacyFallbacks.micFirstFrameTimeoutMs, 3_000);
  assert.equal(legacyFallbacks.probeReplyTimeoutMs, 3_000);
  assert.equal(legacyFallbacks.probeMaxAttempts, 3);
  assert.equal(legacyFallbacks.robotOffsetWindowMs, 2_000);
  assert.equal(legacyFallbacks.robotContentTransitionLifetimeMs, 15_000);
  assert.equal(legacyFallbacks.robotContentTransitionMaxWindows, 12);
  assert.equal(legacyFallbacks.robotContentTransitionMaxWorkerFailures, 3);

  assert.equal(loadRelayConfig({ RELAY_TAKE_DIR: '' }).takeDir, '');
  assert.equal(
    loadRelayConfig({ NODE_ENV: 'production', RELAY_TEST_LEGACY_INFRASTRUCTURE: '1' })
      .legacyTestInfrastructure,
    false,
  );
  assert.throws(
    () => loadRelayConfig({ RELAY_INFRA_KEY: 'ABC' }),
    /RELAY_INFRA_KEY must be a 64-character lowercase hexadecimal secret/,
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

test('relay config validates content calibration runtime validation policy', () => {
  const defaults = loadRelayConfig({});
  assert.equal(defaults.contentValidation, true);
  assert.equal(defaults.contentValidationIntervalMs, 30_000);
  assert.equal(defaults.contentValidationRetryMs, 10_000);
  assert.equal(defaults.contentValidationDeviationMs, 30);

  const configured = loadRelayConfig({
    RELAY_CALIBRATION_VALIDATION: '0',
    RELAY_CALIBRATION_VALIDATION_INTERVAL_MS: '12000',
    RELAY_CALIBRATION_VALIDATION_RETRY_MS: '3000',
    RELAY_CALIBRATION_VALIDATION_DEVIATION_MS: '45',
  });
  assert.equal(configured.contentValidation, false);
  assert.equal(configured.contentValidationIntervalMs, 12_000);
  assert.equal(configured.contentValidationRetryMs, 3_000);
  assert.equal(configured.contentValidationDeviationMs, 45);

  assert.throws(
    () => loadRelayConfig({ RELAY_CALIBRATION_VALIDATION: 'sometimes' }),
    /must be one of: 1, 0, true, false/,
  );
  assert.throws(
    () => loadRelayConfig({ RELAY_CALIBRATION_VALIDATION_DEVIATION_MS: '0' }),
    />= 1/,
  );
});

test('content validation remains independently enabled when auto calibration is off', () => {
  const config = loadRelayConfig({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_VALIDATION: '1',
  });

  assert.equal(config.autoCalibrate, false);
  assert.equal(config.contentValidation, true);
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
