import {
  MIC_PRESENCE_BAR_COUNT,
  nextPresenceHistory,
  presenceHeightPx,
} from './mic-presence-model.js';

const meter = document.querySelector('#mic-input-meter');

if (meter) {
  const bars = Array.from({ length: MIC_PRESENCE_BAR_COUNT }, () => {
    const bar = document.createElement('span');
    bar.className = 'voice-presence-bar';
    bar.setAttribute('aria-hidden', 'true');
    return bar;
  });

  meter.classList.add('voice-presence');
  meter.setAttribute('aria-hidden', 'true');
  meter.replaceChildren(...bars);

  let history = Array(MIC_PRESENCE_BAR_COUNT).fill(0);
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  const SAMPLE_INTERVAL_MS = 34;

  function render(active) {
    meter.dataset.active = active ? 'true' : 'false';
    bars.forEach((bar, index) => {
      bar.style.height = `${presenceHeightPx(history[index])}px`;
    });
  }

  function reset() {
    history = Array(MIC_PRESENCE_BAR_COUNT).fill(0);
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
    history = nextPresenceHistory(history, rmsDbfs);
    render(true);
  });

  reset();
}
