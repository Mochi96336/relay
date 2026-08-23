function nullableBoolean(value) {
  return typeof value === 'boolean' ? value : null;
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
      audioSessionType: typeof navigatorLike?.audioSession?.type === 'string'
        ? navigatorLike.audioSession.type
        : null,
    };
  } catch {
    return null;
  }
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
