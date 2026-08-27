import assert from 'node:assert/strict';
import test from 'node:test';

import { loadRelayConfig } from '../src/config.js';
import { applyLegacyServerEnvironment } from '../src/relay-runtime.js';
import { readRepositoryTextFile } from './helpers/source-contract.js';

function expectedLegacyEnvironment(config: ReturnType<typeof loadRelayConfig>) {
  return {
    PORT: String(config.port),
    RELAY_LIVE_PREBUFFER_MS: String(config.livePrebufferMs),
    RELAY_MIC_RETENTION_MS: String(config.micRetentionMs),
    RELAY_CALIBRATION_TIMEOUT_MS: String(config.calibrationTimeoutMs),
    RELAY_HEARTBEAT_MS: String(config.heartbeatMs),
    RELAY_PARTICIPANT_GRACE_MS: String(config.participantGraceMs),
    RELAY_MIC_TRANSPORT_GRACE_MS: String(config.micTransportGraceMs),
    RELAY_AUTO_CALIBRATE: config.autoCalibrate ? '1' : '0',
    RELAY_AUTO_CALIBRATION_RETRY_MS: String(config.autoCalibrationRetryMs),
    RELAY_CALIBRATION_VALIDATION: config.contentValidation ? '1' : '0',
    RELAY_CALIBRATION_VALIDATION_INTERVAL_MS: String(config.contentValidationIntervalMs),
    RELAY_CALIBRATION_VALIDATION_RETRY_MS: String(config.contentValidationRetryMs),
    RELAY_CALIBRATION_VALIDATION_DEVIATION_MS: String(config.contentValidationDeviationMs),
    RELAY_CALIBRATION_PROBE: config.probeCalibrate ? '1' : '0',
    RELAY_CALIBRATION_PROBE_RETRY_MS: String(config.probeRetryMs),
    RELAY_CALIBRATION_PROBE_LEAD_MS: String(config.probeLeadMs),
    RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: String(config.probeSearchMarginMs),
    RELAY_CALIBRATION_PROBE_MIN_CORRELATION: String(config.probeMinCorrelation),
    RELAY_CALIBRATION_PROBE_DEBUG: config.probeDebug ? '1' : '0',
    RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: String(config.probeAnalysisTimeoutMs),
    RELAY_CALIBRATION_DELTA_REAPPLY_MS: String(config.calibrationDeltaReapplyMs),
    RELAY_BACKING_GRACE_MS: String(config.backingGraceMs),
    RELAY_CALIBRATION_AGREEMENT: String(config.calibrationAgreement),
    RELAY_CALIBRATION_TOLERANCE_MS: String(config.calibrationToleranceMs),
    RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE: String(config.calibrationProvisionalConfidence),
    RELAY_CALIBRATION_MAX_LAG_MS: String(config.calibrationMaxLagMs),
    RELAY_KEY: config.relayKey!,
  };
}

test('runtime compatibility bridge publishes only normalized server inputs', () => {
  const config = loadRelayConfig({ RELAY_KEY: 'test-relay-key' });
  const env: NodeJS.ProcessEnv = {};

  applyLegacyServerEnvironment(config, env);

  assert.deepEqual(env, expectedLegacyEnvironment(config));
});

test('runtime compatibility bridge removes a stale Relay key when config has none', () => {
  const config = loadRelayConfig({});
  const env: NodeJS.ProcessEnv = { RELAY_KEY: 'stale-key', UNRELATED: 'keep-me' };

  applyLegacyServerEnvironment(config, env);

  assert.equal(env.RELAY_KEY, undefined);
  assert.equal(env.UNRELATED, 'keep-me');
});

test('server entry parses deployment config once and delegates activation', () => {
  const entry = readRepositoryTextFile('src/server-entry.ts');

  assert.match(entry, /startRelayRuntime\(loadRelayConfig\(\)\)/);
  assert.doesNotMatch(entry, /process\.env|server\.js/);
});
