import {
  MIC_PRESENCE_BAND_COUNT,
  MIC_PRESENCE_SLICE_COUNT,
  emptyPresenceSlice,
  nextPresenceHistory,
  presenceSliceGeometry,
} from './mic-presence-model.js';

const meter = document.querySelector('#mic-input-meter');

if (meter) {
  const slices = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, (_, sliceIndex) => {
    const slice = document.createElement('span');
    slice.className = 'voice-presence-slice';
    slice.setAttribute('aria-hidden', 'true');
    // Older evidence gently recedes to the left; newest is always the right edge.
    const age = MIC_PRESENCE_SLICE_COUNT <= 1 ? 1 : sliceIndex / (MIC_PRESENCE_SLICE_COUNT - 1);
    slice.style.opacity = String(0.28 + age * 0.72);

    const shape = document.createElement('span');
    shape.className = 'voice-presence-shape';
    shape.setAttribute('aria-hidden', 'true');
    slice.replaceChildren(shape);
    return { slice, shape };
  });

  meter.classList.add('voice-presence');
  meter.setAttribute('aria-hidden', 'true');
  meter.replaceChildren(...slices.map(({ slice }) => slice));

  let history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
  let sourceKey = null;
  let localActive = false;
  let lastLocalSampleAt = Number.NEGATIVE_INFINITY;
  let localStaleTimer = null;
  let remoteStaleTimer = null;
  const LOCAL_SAMPLE_INTERVAL_MS = 40;
  const LOCAL_EVIDENCE_STALE_MS = 160;
  const REMOTE_EVIDENCE_STALE_MS = 320;

  function render(active) {
    meter.dataset.active = active ? 'true' : 'false';
    slices.forEach(({ shape }, sliceIndex) => {
      const evidence = history[sliceIndex] ?? emptyPresenceSlice();
      const geometry = presenceSliceGeometry(evidence);
      const heightPercent = geometry.height * 100;
      const topPercent = Math.max(0, Math.min(100 - heightPercent, (geometry.center * 100) - (heightPercent / 2)));
      shape.style.top = `${topPercent.toFixed(2)}%`;
      shape.style.height = `${heightPercent.toFixed(2)}%`;
      shape.style.opacity = String(0.035 + geometry.intensity * 0.93);
    });
  }

  function clearLocalStaleTimer() {
    if (localStaleTimer === null) return;
    clearTimeout(localStaleTimer);
    localStaleTimer = null;
  }

  function clearRemoteStaleTimer() {
    if (remoteStaleTimer === null) return;
    clearTimeout(remoteStaleTimer);
    remoteStaleTimer = null;
  }

  function reset(nextSourceKey = null) {
    clearLocalStaleTimer();
    clearRemoteStaleTimer();
    history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
    sourceKey = nextSourceKey;
    lastLocalSampleAt = Number.NEGATIVE_INFINITY;
    render(false);
  }

  function armLocalStaleTimer() {
    clearLocalStaleTimer();
    localStaleTimer = setTimeout(() => {
      localStaleTimer = null;
      if (!localActive) return;
      localActive = false;
      if (sourceKey === 'local') reset();
    }, LOCAL_EVIDENCE_STALE_MS);
  }

  function armRemoteStaleTimer(expectedSourceKey) {
    clearRemoteStaleTimer();
    remoteStaleTimer = setTimeout(() => {
      remoteStaleTimer = null;
      if (localActive || sourceKey !== expectedSourceKey) return;
      reset();
    }, REMOTE_EVIDENCE_STALE_MS);
  }

  function append(source, rmsDbfs, spectrumBands) {
    if (source !== sourceKey) reset(source);
    history = nextPresenceHistory(history, rmsDbfs, spectrumBands);
    render(true);
    if (source.startsWith('room:')) armRemoteStaleTimer(source);
  }

  window.addEventListener('relay-local-mic-level', (event) => {
    if (event.detail?.active !== true) {
      localActive = false;
      clearLocalStaleTimer();
      if (sourceKey === 'local') reset();
      return;
    }

    const rmsDbfs = Number(event.detail?.rmsDbfs);
    if (!Number.isFinite(rmsDbfs)) return;

    localActive = true;
    armLocalStaleTimer();
    const now = performance.now();
    if (now - lastLocalSampleAt < LOCAL_SAMPLE_INTERVAL_MS) return;
    lastLocalSampleAt = now;
    append('local', rmsDbfs, event.detail?.spectrumBands);
  });

  window.addEventListener('relay-room-mic-presence', (event) => {
    if (localActive) return;

    if (event.detail?.active !== true) {
      if (typeof sourceKey === 'string' && sourceKey.startsWith('room:')) reset();
      return;
    }

    const ownerId = typeof event.detail?.ownerId === 'string' ? event.detail.ownerId : '';
    const generation = Number(event.detail?.captureGeneration);
    const rmsDbfs = Number(event.detail?.rmsDbfs);
    const spectrumBands = Array.isArray(event.detail?.spectrumBands)
      ? event.detail.spectrumBands.slice(0, MIC_PRESENCE_BAND_COUNT).map(Number)
      : [];
    if (
      !ownerId
      || !Number.isInteger(generation)
      || generation < 0
      || generation > 0xffff_ffff
      || !Number.isFinite(rmsDbfs)
      || spectrumBands.length !== MIC_PRESENCE_BAND_COUNT
      || !spectrumBands.every((band) => Number.isFinite(band) && band >= 0 && band <= 1)
    ) return;

    append(`room:${ownerId}:${generation >>> 0}`, rmsDbfs, spectrumBands);
  });

  reset();
}
