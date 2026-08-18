import {
  MIC_PRESENCE_BAND_COUNT,
  MIC_PRESENCE_SLICE_COUNT,
  emptyPresenceSlice,
  nextPresenceHistory,
} from './mic-presence-model.js';

const meter = document.querySelector('#mic-input-meter');

if (meter) {
  const slices = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, (_, sliceIndex) => {
    const slice = document.createElement('span');
    slice.className = 'voice-presence-slice';
    slice.setAttribute('aria-hidden', 'true');
    // Older evidence gently recedes to the left; newest is always the right edge.
    const age = MIC_PRESENCE_SLICE_COUNT <= 1 ? 1 : sliceIndex / (MIC_PRESENCE_SLICE_COUNT - 1);
    slice.style.opacity = String(0.36 + age * 0.64);

    const bands = Array.from({ length: MIC_PRESENCE_BAND_COUNT }, (_, bandIndex) => {
      const band = document.createElement('span');
      band.className = 'voice-presence-band';
      band.dataset.band = String(bandIndex);
      band.setAttribute('aria-hidden', 'true');
      return band;
    });
    slice.replaceChildren(...bands);
    return { slice, bands };
  });

  meter.classList.add('voice-presence');
  meter.setAttribute('aria-hidden', 'true');
  meter.replaceChildren(...slices.map(({ slice }) => slice));

  let history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
  let sourceKey = null;
  let localActive = false;
  let lastLocalSampleAt = Number.NEGATIVE_INFINITY;
  let remoteStaleTimer = null;
  const LOCAL_SAMPLE_INTERVAL_MS = 40;
  const REMOTE_EVIDENCE_STALE_MS = 320;

  function render(active) {
    meter.dataset.active = active ? 'true' : 'false';
    slices.forEach(({ bands }, sliceIndex) => {
      const evidence = history[sliceIndex] ?? emptyPresenceSlice();
      bands.forEach((band, bandIndex) => {
        const level = Math.max(0, Math.min(1, Number(evidence.bands?.[bandIndex]) || 0));
        // Compute the visual interpolation in JS instead of relying on CSS
        // arithmetic involving custom properties; this keeps the ribbon stable
        // on the older Safari/WebKit versions that phones may still run.
        band.style.opacity = String(0.055 + level * 0.88);
        band.style.transform = `scaleX(${0.48 + level * 0.52})`;
      });
    });
  }

  function clearRemoteStaleTimer() {
    if (remoteStaleTimer === null) return;
    clearTimeout(remoteStaleTimer);
    remoteStaleTimer = null;
  }

  function reset(nextSourceKey = null) {
    clearRemoteStaleTimer();
    history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
    sourceKey = nextSourceKey;
    lastLocalSampleAt = Number.NEGATIVE_INFINITY;
    render(false);
  }

  function armRemoteStaleTimer(expectedSourceKey) {
    clearRemoteStaleTimer();
    remoteStaleTimer = setTimeout(() => {
      remoteStaleTimer = null;
      // Presence is evidence, not state. If several expected 80 ms telemetry
      // packets never arrive, stop displaying the last packet as if it were
      // still live. The existing 110 ms band transitions soften the reset.
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
      if (sourceKey === 'local') reset();
      return;
    }

    const rmsDbfs = Number(event.detail?.rmsDbfs);
    if (!Number.isFinite(rmsDbfs)) return;

    localActive = true;
    const now = performance.now();
    if (now - lastLocalSampleAt < LOCAL_SAMPLE_INTERVAL_MS) return;
    lastLocalSampleAt = now;
    append('local', rmsDbfs, event.detail?.spectrumBands);
  });

  window.addEventListener('relay-room-mic-presence', (event) => {
    // The singer keeps the zero-network-latency local evidence. Room telemetry
    // is for everyone else and must never replace the singer's own capture.
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

    // Owner + generation is the identity of this visible sound. A Mic handoff
    // or new capture resets the tail instead of visually welding two people
    // together for the next few hundred milliseconds.
    append(`room:${ownerId}:${generation >>> 0}`, rmsDbfs, spectrumBands);
  });

  reset();
}
