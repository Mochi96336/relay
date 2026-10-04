
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
const MAX_INPUT_LABEL_LENGTH = 64;
const MAX_DEVICE_LENGTH = 96;

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

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

// In-app browsers first: they also carry the engine's own Safari/Chrome token.
const BROWSER_PATTERNS = [
  [/\bLine\/(\d+(?:\.\d+)?)/i, 'LINE'],
  [/\bFBAV\/(\d+)/, 'Facebook'],
  [/\bInstagram (\d+)/, 'Instagram'],
  [/\bEdg(?:iOS|A)?\/(\d+)/, 'Edge'],
  [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\b(?:CriOS|Chrome)\/(\d+)/, 'Chrome'],
  [/\b(?:FxiOS|Firefox)\/(\d+)/, 'Firefox'],
  [/\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//, 'Safari'],
];

function platformName(userAgent, maxTouchPoints) {
  const apple = userAgent.match(/\b(iPhone|iPad|iPod)\b.*?\bOS (\d+)_(\d+)/);
  if (apple) return `${apple[1]} iOS ${apple[2]}.${apple[3]}`;
  // iPadOS Safari asks for desktop pages by claiming to be a Mac.
  if (/\bMacintosh\b/.test(userAgent)) return maxTouchPoints > 1 ? 'iPad' : 'Mac';
  const android = userAgent.match(/\bAndroid (\d+(?:\.\d+)?)(?:; ([^;)]+))?/);
  if (android) {
    // Chrome's reduced user agent replaces the model with "K".
    const model = android[2]?.replace(/\s*Build\/.*$/, '').trim();
    return model && model !== 'K' ? `Android ${android[1]} ${model}` : `Android ${android[1]}`;
  }
  if (/\bWindows\b/.test(userAgent)) return 'Windows';
  if (/\bCrOS\b/.test(userAgent)) return 'ChromeOS';
  if (/\bLinux\b/.test(userAgent)) return 'Linux';
  return null;
}

/**
 * A short name for the device and browser behind a capture, such as
 * "iPhone iOS 18.6 · Safari 26.0", so a log line can say which singer's phone
 * it was. Diagnostic only and best effort: recent iOS freezes the OS version in
 * the user agent (the Safari version still moves), and Android hides the model.
 */
export function describeCaptureDevice(navigatorLike = globalThis.navigator) {
  const userAgent = typeof navigatorLike?.userAgent === 'string' ? navigatorLike.userAgent : '';
  if (!userAgent) return null;
  const platform = platformName(userAgent, Number(navigatorLike?.maxTouchPoints) || 0);
  let browser = null;
  for (const [pattern, name] of BROWSER_PATTERNS) {
    const match = userAgent.match(pattern);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  const parts = [platform, browser].filter(Boolean);
  return boundedText(parts.length > 0 ? parts.join(' · ') : userAgent, MAX_DEVICE_LENGTH);
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
      // Which microphone, e.g. a headset's name. Browsers may leave it empty.
      inputLabel: boundedText(track.label, MAX_INPUT_LABEL_LENGTH),
      device: describeCaptureDevice(navigatorLike),
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
