import {
  MIC_PRESENCE_BAND_COUNT,
  MIC_PRESENCE_SLICE_COUNT,
  emptyPresenceSlice,
  nextPresenceHistory,
} from './mic-presence-model.js';

const meter = document.querySelector('#mic-input-meter');

if (meter) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEWBOX_WIDTH = 320;
  const VIEWBOX_HEIGHT = 56;
  const CENTER_Y = VIEWBOX_HEIGHT / 2;
  const MAX_AMPLITUDE = 18;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('voice-presence-svg');
  svg.setAttribute('viewBox', `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const baseline = document.createElementNS(SVG_NS, 'path');
  baseline.classList.add('voice-presence-baseline');
  baseline.setAttribute('d', `M 0 ${CENTER_Y} L ${VIEWBOX_WIDTH} ${CENTER_Y}`);

  const wave = document.createElementNS(SVG_NS, 'path');
  wave.classList.add('voice-presence-wave');
  wave.setAttribute('aria-hidden', 'true');

  svg.append(baseline, wave);
  meter.classList.add('voice-presence');
  meter.setAttribute('aria-hidden', 'true');
  meter.replaceChildren(svg);

  let history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
  let sourceKey = null;
  let localActive = false;
  let lastLocalSampleAt = Number.NEGATIVE_INFINITY;
  let localStaleTimer = null;
  let remoteStaleTimer = null;
  const LOCAL_SAMPLE_INTERVAL_MS = 40;
  const LOCAL_EVIDENCE_STALE_MS = 160;
  const REMOTE_EVIDENCE_STALE_MS = 320;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function smoothPath(points) {
    if (!points.length) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

    let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[index - 1] ?? points[index];
      const p1 = points[index];
      const p2 = points[index + 1];
      const p3 = points[index + 2] ?? p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return path;
  }

  function envelopePath() {
    const divisor = Math.max(1, MIC_PRESENCE_SLICE_COUNT - 1);
    const upper = history.map((slice, index) => {
      const presence = clamp(Number(slice?.presence) || 0, 0, 1);
      const amplitude = Math.pow(presence, 1.35) * MAX_AMPLITUDE;
      return {
        x: (index / divisor) * VIEWBOX_WIDTH,
        y: CENTER_Y - amplitude,
      };
    });
    const lower = history.map((slice, index) => {
      const presence = clamp(Number(slice?.presence) || 0, 0, 1);
      const amplitude = Math.pow(presence, 1.35) * MAX_AMPLITUDE;
      return {
        x: (index / divisor) * VIEWBOX_WIDTH,
        y: CENTER_Y + amplitude,
      };
    }).reverse();

    const upperPath = smoothPath(upper);
    const lowerPath = smoothPath(lower);
    if (!upperPath || !lowerPath) return '';
    return `${upperPath} L ${lower[0].x.toFixed(2)} ${lower[0].y.toFixed(2)} ${lowerPath.replace(/^M [^C]+/, '')} Z`;
  }

  function render(active) {
    meter.dataset.active = active ? 'true' : 'false';
    wave.setAttribute('d', envelopePath());
    const strongest = history.reduce((max, slice) => Math.max(max, Number(slice?.presence) || 0), 0);
    wave.style.opacity = active ? String(0.08 + clamp(strongest, 0, 1) * 0.86) : '0';
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
