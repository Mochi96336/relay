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
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  const SAMPLE_INTERVAL_MS = 40;

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

  function reset() {
    history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
    lastSampleAt = Number.NEGATIVE_INFINITY;
    render(false);
  }

  window.addEventListener('relay-local-mic-level', (event) => {
    if (event.detail?.active !== true) {
      reset();
      return;
    }

    const rmsDbfs = Number(event.detail?.rmsDbfs);
    if (!Number.isFinite(rmsDbfs)) return;

    const now = performance.now();
    if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
    lastSampleAt = now;
    history = nextPresenceHistory(history, rmsDbfs, event.detail?.spectrumBands);
    render(true);
  });

  reset();
}
