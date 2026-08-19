import process from 'node:process';

import { loadRelayConfig } from './config.js';

// Parse once at the process boundary, then publish only normalized values to the
// legacy server module. This makes config.ts the deployment source of truth
// without forcing the large server module to carry a second parsing layer.
const config = loadRelayConfig();
Object.assign(process.env, {
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
});
if (config.relayKey === null) delete process.env.RELAY_KEY;
else process.env.RELAY_KEY = config.relayKey;

await import('./server.js');
