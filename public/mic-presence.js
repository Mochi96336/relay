import {
  MIC_PRESENCE_BAND_COUNT,
  MIC_PRESENCE_MAX_F0_HZ,
  MIC_PRESENCE_MIN_F0_HZ,
  MIC_PRESENCE_SLICE_COUNT,
  centerOriginX,
  emptyPresenceSlice,
  nextPresenceHistory,
  presenceSliceGeometry,
} from './mic-presence-model.js';

const meter = document.querySelector('#mic-input-meter');

if (meter) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEWBOX_WIDTH = 320;
  const VIEWBOX_HEIGHT = 56;
  const CENTER_Y = VIEWBOX_HEIGHT / 2;
  const MAX_AMPLITUDE = 18;
  const PITCH_MODULATION_DEPTH = 0.18;
  const ROOM_EVIDENCE_STALE_MS = 320;

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
  let roomStaleTimer = null;
  let roomAuthorityFresh = false;
  let authoritativeRoomOwnerId = null;
  let authoritativeRoomLive = false;

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

  function visualPoint(slice, index, side) {
    const geometry = presenceSliceGeometry(slice);
    const positions = centerOriginX(index, history.length, VIEWBOX_WIDTH);
    const x = side === 'left' ? positions.left : positions.right;
    const distance = Math.abs(x - VIEWBOX_WIDTH / 2) / (VIEWBOX_WIDTH / 2);
    const pitchTexture = geometry.pitchStrength > 0
      ? Math.sin(2 * Math.PI * geometry.density * distance) * geometry.pitchStrength * PITCH_MODULATION_DEPTH
      : 0;
    const amplitude = clamp(
      geometry.amplitude * MAX_AMPLITUDE * (1 + pitchTexture),
      0,
      MAX_AMPLITUDE,
    );
    return { x, amplitude };
  }

  function envelopePath() {
    const left = history.map((slice, index) => visualPoint(slice, index, 'left'));
    const right = history
      .slice(0, -1)
      .map((slice, index) => visualPoint(slice, index, 'right'))
      .reverse();
    const samples = [...left, ...right];
    const upper = samples.map((point) => ({ x: point.x, y: CENTER_Y - point.amplitude }));
    const lower = samples.map((point) => ({ x: point.x, y: CENTER_Y + point.amplitude })).reverse();

    const upperPath = smoothPath(upper);
    const lowerPath = smoothPath(lower);
    if (!upperPath || !lowerPath) return '';
    return `${upperPath} L ${lower[0].x.toFixed(2)} ${lower[0].y.toFixed(2)} ${lowerPath.replace(/^M [^C]+/, '')} Z`;
  }

  function render(active) {
    meter.dataset.active = active ? 'true' : 'false';
    wave.setAttribute('d', envelopePath());
    wave.style.opacity = active ? '0.9' : '0';
  }

  function clearRoomStaleTimer() {
    if (roomStaleTimer === null) return;
    clearTimeout(roomStaleTimer);
    roomStaleTimer = null;
  }

  function reset(nextSourceKey = null) {
    clearRoomStaleTimer();
    history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
    sourceKey = nextSourceKey;
    render(false);
  }

  function armRoomStaleTimer(expectedSourceKey) {
    clearRoomStaleTimer();
    roomStaleTimer = setTimeout(() => {
      roomStaleTimer = null;
      if (sourceKey !== expectedSourceKey) return;
      reset();
    }, ROOM_EVIDENCE_STALE_MS);
  }

  function append(source, rmsDbfs, spectrumBands, f0Hz, pitchConfidence) {
    if (source !== sourceKey) reset(source);
    history = nextPresenceHistory(history, rmsDbfs, spectrumBands, f0Hz, pitchConfidence);
    render(true);
    armRoomStaleTimer(source);
  }

  function validGeneration(value) {
    const generation = Number(value);
    return Number.isInteger(generation) && generation >= 0 && generation <= 0xffff_ffff
      ? generation >>> 0
      : null;
  }

  function validPitch(f0Value, confidenceValue) {
    const confidence = Number(confidenceValue);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    if (f0Value === null || f0Value === undefined) {
      return { f0Hz: null, pitchConfidence: confidence };
    }
    const f0Hz = Number(f0Value);
    if (
      !Number.isFinite(f0Hz)
      || f0Hz < MIC_PRESENCE_MIN_F0_HZ
      || f0Hz > MIC_PRESENCE_MAX_F0_HZ
    ) return null;
    return { f0Hz, pitchConfidence: confidence };
  }

  function syncAuthoritativeRoomSurface() {
    if (document.body?.dataset) {
      document.body.dataset.roomMic = roomAuthorityFresh && authoritativeRoomLive ? 'live' : 'off';
    }
  }

  function adoptRoomAuthority(authority) {
    const fresh = authority?.authorityFresh === true;
    const status = authority?.lastKnownSnapshot ?? null;
    const mic = status?.room?.mic ?? {};
    const ownerId = fresh && typeof mic.ownerId === 'string' ? mic.ownerId : null;
    const live = fresh && mic.state === 'live' && ownerId !== null;
    const changed = ownerId !== authoritativeRoomOwnerId || live !== authoritativeRoomLive;

    roomAuthorityFresh = fresh;
    authoritativeRoomOwnerId = ownerId;
    authoritativeRoomLive = live;
    syncAuthoritativeRoomSurface();
    if (!live || changed) reset();
  }

  window.addEventListener('relay-product-authority', (event) => {
    adoptRoomAuthority(event.detail);
  });

  window.addEventListener('relay-room-mic-presence', (event) => {
    if (event.detail?.active !== true) {
      syncAuthoritativeRoomSurface();
      reset();
      return;
    }

    const ownerId = typeof event.detail?.ownerId === 'string' ? event.detail.ownerId : '';
    const generation = validGeneration(event.detail?.captureGeneration);
    const rmsDbfs = Number(event.detail?.rmsDbfs);
    const spectrumBands = Array.isArray(event.detail?.spectrumBands)
      ? event.detail.spectrumBands.slice(0, MIC_PRESENCE_BAND_COUNT).map(Number)
      : [];
    const pitch = validPitch(event.detail?.f0Hz, event.detail?.pitchConfidence);
    if (
      !roomAuthorityFresh
      || !authoritativeRoomLive
      || ownerId !== authoritativeRoomOwnerId
      || generation === null
      || !Number.isFinite(rmsDbfs)
      || spectrumBands.length !== MIC_PRESENCE_BAND_COUNT
      || !spectrumBands.every((band) => Number.isFinite(band) && band >= 0 && band <= 1)
      || !pitch
    ) {
      syncAuthoritativeRoomSurface();
      return;
    }

    syncAuthoritativeRoomSurface();
    append(
      `room:${ownerId}:${generation}`,
      rmsDbfs,
      spectrumBands,
      pitch.f0Hz,
      pitch.pitchConfidence,
    );
  });

  adoptRoomAuthority(window.relayProductAuthority ?? null);
  reset();
}
