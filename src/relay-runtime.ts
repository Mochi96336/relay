import process from 'node:process';

import type { loadRelayConfig } from './config.js';

export type RelayConfig = ReturnType<typeof loadRelayConfig>;

/**
 * Transitional adapter for the current server module.
 *
 * `loadRelayConfig()` is the deployment parser and produces normalized values.
 * `server.ts` still reads its historical process.env inputs at module load, so
 * keep that compatibility mutation behind this single runtime boundary until
 * the server is constructed from RelayConfig directly.
 */
export function applyLegacyServerEnvironment(
  config: RelayConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  Object.assign(env, {
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

  if (config.relayKey === null) delete env.RELAY_KEY;
  else env.RELAY_KEY = config.relayKey;
}

/**
 * Composition boundary for the current Relay process.
 *
 * Activation still crosses one compatibility bridge into the legacy
 * side-effectful server module, but process signal ownership now terminates at
 * this composition boundary. Future extraction should move construction/startup
 * behind the same boundary without putting deployment parsing back into `server.ts`.
 */
export async function startRelayRuntime(config: RelayConfig) {
  applyLegacyServerEnvironment(config);
  const relayServer = await import('./server.js');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      // Process lifecycle belongs at the composition boundary. Keep both
      // handlers installed while the server's idempotent shutdown transaction
      // is active so repeated signals join the same durability barrier.
      void relayServer.gracefulShutdown(signal).finally(() => {
        process.exit(process.exitCode ?? 0);
      });
    });
  }
}
