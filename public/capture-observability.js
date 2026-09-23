
const VOICE_PROCESSING_KEYS = [
  'echoCancellation',
  'noiseSuppression',
  'autoGainControl',
];

/**
 * After permission, tighten only the browser voice-processing features that
 * are both visibly enabled and explicitly controllable to false on this track.
 *
 * getUserMedia({ ...: false }) is a preference and may be ignored. For singing
 * into an external speaker, leaving AEC/NS/AGC on can sound robotic or buzzy.
 * Exact constraints are attempted only when getCapabilities() proves that
 * `false` is available; unsupported/unknown browsers keep their existing
 * capture path.
 */
export async function enforceUnprocessedCapture(stream) {
  const track = stream?.getAudioTracks?.()[0];
  if (
    !track
    || typeof track.getSettings !== 'function'
    || typeof track.getCapabilities !== 'function'
    || typeof track.applyConstraints !== 'function'
  ) return false;

  let settings;
  let capabilities;
  let constraints = {};
  try {
    settings = track.getSettings();
    capabilities = track.getCapabilities();
    const current = typeof track.getConstraints === 'function'
      ? track.getConstraints()
      : null;
    if (current && typeof current === 'object') constraints = { ...current };
  } catch {
    return false;
  }

  const candidates = VOICE_PROCESSING_KEYS.filter((key) => (
    settings?.[key] === true
    && Array.isArray(capabilities?.[key])
    && capabilities[key].includes(false)
  ));
  if (candidates.length === 0) return false;

  let changed = false;
  for (const key of candidates) {
    const next = {
      ...constraints,
      [key]: { exact: false },
    };
    try {
      await track.applyConstraints(next);
      constraints = next;
      changed = true;
    } catch {
      // Best effort per feature: one unsupported combination must not stop the
      // microphone or prevent another independently-controllable processor from
      // being disabled.
    }
  }
  return changed;
}

export function captureVoiceProcessingActive(settings) {
  return Boolean(
    settings
    && VOICE_PROCESSING_KEYS.some((key) => settings[key] === true)
  );
}

const MAX_AUDIO_SESSION_TYPE_LENGTH = 64;

function nullableBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function boundedAudioSessionType(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_AUDIO_SESSION_TYPE_LENGTH
    ? value
    : null;
}

/**
 * Reports only settings the browser says it actually applied to the live track.
 * Unsupported APIs and unknown values stay null; requested constraints are not
 * substituted because they are not evidence of the resulting capture path.
 */
export function readCaptureSettings(stream, navigatorLike = globalThis.navigator) {
  try {
    const track = stream?.getAudioTracks?.()[0];
    if (!track || typeof track.getSettings !== 'function') return null;
    const settings = track.getSettings();
    if (!settings || typeof settings !== 'object') return null;

    return {
      echoCancellation: nullableBoolean(settings.echoCancellation),
      noiseSuppression: nullableBoolean(settings.noiseSuppression),
      autoGainControl: nullableBoolean(settings.autoGainControl),
      audioSessionType: boundedAudioSessionType(navigatorLike?.audioSession?.type),
    };
  } catch {
    return null;
  }
}

function nonNegativeSafeInteger(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

export function captureClippingSnapshot(level) {
  const railSamples = nonNegativeSafeInteger(level?.railSamples);
  const maxConsecutiveRailSamples = nonNegativeSafeInteger(level?.maxConsecutiveRailSamples);
  const rawWindowMax = level?.windowMaxConsecutiveRailSamples;
  const windowMaxConsecutiveRailSamples = rawWindowMax === undefined
    ? undefined
    : nonNegativeSafeInteger(rawWindowMax);
  if (
    railSamples === null
    || maxConsecutiveRailSamples === null
    || maxConsecutiveRailSamples > railSamples
    || windowMaxConsecutiveRailSamples === null
    || (
      windowMaxConsecutiveRailSamples !== undefined
      && windowMaxConsecutiveRailSamples > maxConsecutiveRailSamples
    )
  ) return null;
  return {
    railSamples,
    maxConsecutiveRailSamples,
    ...(windowMaxConsecutiveRailSamples === undefined
      ? {}
      : { windowMaxConsecutiveRailSamples }),
  };
}

/**
 * Four consecutive near-full-scale raw samples are strong evidence of a
 * flattened input rail, rather than one ordinary full-scale waveform peak.
 * This capture-lifetime verdict preserves the existing local Adjust guidance.
 */
export function captureInputClippingDetected(clipping) {
  return Boolean(
    clipping
    && Number.isSafeInteger(clipping.maxConsecutiveRailSamples)
    && clipping.maxConsecutiveRailSamples >= 4
  );
}

/**
 * The same flat-top policy applied only to one worklet level window. This is
 * what health aggregation uses so room/product status can clear after clean
 * input rather than inheriting a capture-lifetime maximum forever.
 */
export function captureRecentInputClippingDetected(clipping) {
  return Boolean(
    clipping
    && Number.isSafeInteger(clipping.windowMaxConsecutiveRailSamples)
    && clipping.windowMaxConsecutiveRailSamples >= 4
  );
}

/** Bounded worklet-level diagnostic projection; never a calibration gate. */
export function captureLevelSnapshot(level) {
  const peakDbfs = level?.peakDbfs;
  const rmsDbfs = level?.rmsDbfs;
  if (
    typeof peakDbfs !== 'number'
    || typeof rmsDbfs !== 'number'
    || !Number.isFinite(peakDbfs)
    || !Number.isFinite(rmsDbfs)
    || peakDbfs > 0
    || rmsDbfs > peakDbfs
  ) return null;
  return { peakDbfs, rmsDbfs };
}
