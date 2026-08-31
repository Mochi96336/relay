import process from 'node:process';

export type Env = Readonly<Record<string, string | undefined>>;

type NumberOptions = {
  min?: number;
  max?: number;
  integer?: boolean;
};

function rawValue(env: Env, name: string) {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function envNumber(
  env: Env,
  name: string,
  fallback: number,
  { min = -Infinity, max = Infinity, integer = false }: NumberOptions = {},
) {
  const raw = rawValue(env, name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  if (value < min || value > max) {
    const range = Number.isFinite(min) && Number.isFinite(max)
      ? `from ${min} to ${max}`
      : Number.isFinite(min)
        ? `>= ${min}`
        : `<= ${max}`;
    throw new Error(`${name} must be ${range}.`);
  }
  return value;
}

export function envBoolean(env: Env, name: string, fallback: boolean) {
  const raw = rawValue(env, name);
  if (raw === undefined) return fallback;

  switch (raw.toLowerCase()) {
    case '1':
    case 'true':
      return true;
    case '0':
    case 'false':
      return false;
    default:
      throw new Error(`${name} must be one of: 1, 0, true, false.`);
  }
}

function legacyPositiveNumber(env: Env, name: string, fallback: number) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function legacyPositiveInt(env: Env, name: string, fallback: number) {
  const value = Number(env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function relayInfrastructureKey(env: Env) {
  const raw = env.RELAY_INFRA_KEY?.trim() ?? '';
  if (raw && !/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error('RELAY_INFRA_KEY must be a 64-character lowercase hexadecimal secret.');
  }
  return raw || null;
}

export function loadRelayConfig(env: Env = process.env) {
  return {
    port: envNumber(env, 'PORT', 3000, { min: 0, max: 65_535, integer: true }),
    relayKey: rawValue(env, 'RELAY_KEY') ?? null,
    takeDir: env.RELAY_TAKE_DIR ?? 'takes',
    infrastructureKey: relayInfrastructureKey(env),
    legacyTestInfrastructure: env.NODE_ENV === 'test'
      && env.RELAY_TEST_LEGACY_INFRASTRUCTURE === '1',
    monitorBacklogMs: legacyPositiveNumber(env, 'RELAY_MONITOR_BACKLOG_MS', 200),
    micFirstFrameTimeoutMs: legacyPositiveNumber(env, 'RELAY_MIC_FIRST_FRAME_TIMEOUT_MS', 3_000),
    probeReplyTimeoutMs: legacyPositiveNumber(env, 'RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS', 3_000),
    probeMaxAttempts: legacyPositiveInt(env, 'RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS', 3),
    robotOffsetWindowMs: legacyPositiveNumber(env, 'RELAY_ROBOT_OFFSET_WINDOW_MS', 2_000),
    robotContentTransitionLifetimeMs: legacyPositiveNumber(
      env,
      'RELAY_ROBOT_CONTENT_TRANSITION_LIFETIME_MS',
      15_000,
    ),
    robotContentTransitionMaxWindows: legacyPositiveInt(
      env,
      'RELAY_ROBOT_CONTENT_TRANSITION_MAX_WINDOWS',
      12,
    ),
    robotContentTransitionMaxWorkerFailures: legacyPositiveInt(
      env,
      'RELAY_ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES',
      3,
    ),
    livePrebufferMs: envNumber(env, 'RELAY_LIVE_PREBUFFER_MS', 400, { min: 1 }),
    micRetentionMs: envNumber(env, 'RELAY_MIC_RETENTION_MS', 3_000, { min: 1 }),
    calibrationTimeoutMs: envNumber(env, 'RELAY_CALIBRATION_TIMEOUT_MS', 20_000, { min: 1 }),
    heartbeatMs: envNumber(env, 'RELAY_HEARTBEAT_MS', 8_000, { min: 100 }),
    participantGraceMs: envNumber(env, 'RELAY_PARTICIPANT_GRACE_MS', 5_000, { min: 1 }),
    micTransportGraceMs: envNumber(env, 'RELAY_MIC_TRANSPORT_GRACE_MS', 5_000, { min: 1 }),
    autoCalibrate: envBoolean(env, 'RELAY_AUTO_CALIBRATE', true),
    autoCalibrationRetryMs: envNumber(env, 'RELAY_AUTO_CALIBRATION_RETRY_MS', 15_000, { min: 1 }),
    contentValidation: envBoolean(env, 'RELAY_CALIBRATION_VALIDATION', true),
    contentValidationIntervalMs: envNumber(
      env,
      'RELAY_CALIBRATION_VALIDATION_INTERVAL_MS',
      30_000,
      { min: 1 },
    ),
    contentValidationRetryMs: envNumber(
      env,
      'RELAY_CALIBRATION_VALIDATION_RETRY_MS',
      10_000,
      { min: 1 },
    ),
    contentValidationDeviationMs: envNumber(
      env,
      'RELAY_CALIBRATION_VALIDATION_DEVIATION_MS',
      30,
      { min: 1 },
    ),
    probeCalibrate: envBoolean(env, 'RELAY_CALIBRATION_PROBE', true),
    probeRetryMs: envNumber(env, 'RELAY_CALIBRATION_PROBE_RETRY_MS', 6_000, { min: 1 }),
    probeLeadMs: envNumber(env, 'RELAY_CALIBRATION_PROBE_LEAD_MS', 200, { min: 1 }),
    probeSearchMarginMs: envNumber(env, 'RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS', 3_000, { min: 1 }),
    probeMinCorrelation: envNumber(env, 'RELAY_CALIBRATION_PROBE_MIN_CORRELATION', 0.5, { min: 0, max: 1 }),
    probeDebug: envBoolean(env, 'RELAY_CALIBRATION_PROBE_DEBUG', false),
    probeAnalysisTimeoutMs: envNumber(env, 'RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS', 8_000, { min: 1 }),
    calibrationDeltaReapplyMs: envNumber(env, 'RELAY_CALIBRATION_DELTA_REAPPLY_MS', 40, { min: 1 }),
    backingGraceMs: envNumber(env, 'RELAY_BACKING_GRACE_MS', 10_000, { min: 1 }),
    calibrationAgreement: envNumber(env, 'RELAY_CALIBRATION_AGREEMENT', 3, { min: 1, max: 20, integer: true }),
    calibrationToleranceMs: envNumber(env, 'RELAY_CALIBRATION_TOLERANCE_MS', 25, { min: 1 }),
    calibrationProvisionalConfidence: envNumber(
      env,
      'RELAY_CALIBRATION_PROVISIONAL_CONFIDENCE',
      0.55,
      { min: 0, max: 1 },
    ),
    calibrationMaxLagMs: envNumber(env, 'RELAY_CALIBRATION_MAX_LAG_MS', 2_500, { min: 1 }),
  } as const;
}

export function loadBackingConfig(env: Env = process.env) {
  const configuredUrl = rawValue(env, 'RELAY_URL');
  const rawUrl = configuredUrl ?? (() => {
    // Port zero is useful to the Relay server test harness because the OS picks
    // an ephemeral listener. It is never a usable destination for a separate
    // backing process, so reject it here instead of retrying localhost:0 forever.
    const port = envNumber(env, 'PORT', 3000, { min: 1, max: 65_535, integer: true });
    return `ws://127.0.0.1:${port}/ws`;
  })();

  let relayUrl: URL;
  try {
    relayUrl = new URL(rawUrl);
  } catch {
    throw new Error('RELAY_URL must be a valid URL.');
  }
  if (relayUrl.protocol !== 'ws:' && relayUrl.protocol !== 'wss:') {
    throw new Error('RELAY_URL must use ws:// or wss://.');
  }
  if (relayUrl.port === '0') {
    throw new Error('RELAY_URL port must be from 1 to 65535.');
  }

  const relayKey = rawValue(env, 'RELAY_KEY');
  if (relayKey && !relayUrl.searchParams.has('key')) relayUrl.searchParams.set('key', relayKey);

  return {
    relayUrl: relayUrl.toString(),
    sampleRate: Math.round(envNumber(env, 'RELAY_BACKING_SAMPLE_RATE', 48_000, { min: 8_000, max: 192_000 })),
    frameMs: envNumber(env, 'RELAY_BACKING_FRAME_MS', 20, { min: 1 }),
    reconnectMs: envNumber(env, 'RELAY_BACKING_RECONNECT_MS', 1_000, { min: 50 }),
    maxBufferedBytes: envNumber(env, 'RELAY_BACKING_MAX_BUFFERED_BYTES', 512 * 1024, { min: 1_024 }),
    startupFlushMs: envNumber(env, 'RELAY_BACKING_STARTUP_FLUSH_MS', 250, { min: 0 }),
    robot: envBoolean(env, 'RELAY_BACKING_ROBOT', false),
  } as const;
}
