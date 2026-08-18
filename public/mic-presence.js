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
    slice.style.opacity = String(0.28 + age * 0.72);

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
  let localStaleTimer = null;
  let remoteStaleTimer = null;
  const LOCAL_SAMPLE_INTERVAL_MS = 40;
  const LOCAL_EVIDENCE_STALE_MS = 160;
  const REMOTE_EVIDENCE_STALE_MS = 320;

  function render(active) {
    meter.dataset.active = active ? 'true' : 'false';
    slices.forEach(({ bands }, sliceIndex) => {
      const evidence = history[sliceIndex] ?? emptyPresenceSlice();
      bands.forEach((band, bandIndex) => {
        const level = Math.max(0, Math.min(1, Number(evidence.bands?.[bandIndex]) || 0));
        // Time already lives on the horizontal axis. Varying each cell's width
        // made the truthful 10×5 evidence look like fifty independent LEDs.
        // Keep geometry continuous and let luminance encode band energy instead:
        // high/low frequency still maps vertically, while adjacent time slices
        // visually blend into one moving voice field.
        band.style.opacity = String(0.025 + level * 0.92);
      });
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
      // A stopped/suspended AudioWorklet may never deliver the explicit
      // active:false boundary. Local capture is evidence too: once several
      // expected 40 ms UI samples are missing, stop preferring a frozen local
      // tail over newer authoritative room telemetry.
      if (!localActive) return;
      localActive = false;
      if (sourceKey === 'local') reset();
    }, LOCAL_EVIDENCE_STALE_MS);
  }

  function armRemoteStaleTimer(expectedSourceKey) {
    clearRemoteStaleTimer();
    remoteStaleTimer = setTimeout(() => {
      remoteStaleTimer = null;
      // Presence is evidence, not state. If several expected 80 ms telemetry
      // packets never arrive, stop displaying the last packet as if it were
      // still live. The existing short opacity transitions soften the reset.
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
    // The singer keeps the zero-network-latency local evidence. Room telemetry
    // is for everyone else and must never replace fresh singer capture.
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
