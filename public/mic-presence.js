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
const wave = meter?.querySelector('.voice-presence-wave') ?? null;

if (meter && wave) {
  // The viewBox of the meter's SVG in index.html.
  const VIEWBOX_WIDTH = 320;
  const VIEWBOX_HEIGHT = 56;
  const CENTER_Y = VIEWBOX_HEIGHT / 2;
  const MAX_AMPLITUDE = 22;
  // Lifts quiet and mid levels a little, so ordinary singing moves the band.
  const LEVEL_CURVE = 0.85;
  // Pitch shows as ripples along the edge, denser for higher notes
  // (pitchLobeCount). Deep enough to see, and drawn with extra points between
  // slices: at one point per slice a high note's ripples were lost between
  // samples and every note looked alike.
  // Kept shallow: pitch changes how dense the ripples are, not how big the band is.
  const PITCH_MODULATION_DEPTH = 0.2;
  // Enough points for about nine per ripple at the densest pitch.
  const POINTS_PER_SLICE = 8;
  const ROOM_EVIDENCE_STALE_MS = 320;
  // Room telemetry arrives every ~80 ms; the drawn band eases toward each new
  // shape over about this long instead of jumping to it.
  const EASE_MS = 70;

  let history = Array.from({ length: MIC_PRESENCE_SLICE_COUNT }, () => emptyPresenceSlice());
  let sourceKey = null;
  let roomStaleTimer = null;
  let roomAuthorityFresh = false;
  let authoritativeRoomOwnerId = null;
  let authoritativeRoomLive = false;
  /** The points being drawn, easing toward the history's targets. */
  let drawn = null;
  let frame = null;
  let lastFrameAt = null;
  const animationFrame = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : null;

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

  /** One half of the band, from the newest slice at the centre out to the oldest edge. */
  function halfPoints(side) {
    const slices = history.slice().reverse();
    const last = slices.length - 1;
    // centerOriginX places each slice; points between two slices interpolate.
    const xOf = (index) => centerOriginX(last - index, history.length, VIEWBOX_WIDTH)[side];
    const points = [];
    let phase = 0;
    for (let index = 0; index <= last; index += 1) {
      const here = presenceSliceGeometry(slices[index]);
      const next = index < last ? presenceSliceGeometry(slices[index + 1]) : here;
      const steps = index < last ? POINTS_PER_SLICE : 1;
      for (let step = 0; step < steps; step += 1) {
        const t = step / POINTS_PER_SLICE;
        const x = xOf(index) + ((index < last ? xOf(index + 1) : xOf(index)) - xOf(index)) * t;
        const level = Math.pow(here.amplitude + (next.amplitude - here.amplitude) * t, LEVEL_CURVE);
        const density = here.density + (next.density - here.density) * t;
        const strength = here.pitchStrength + (next.pitchStrength - here.pitchStrength) * t;
        const ripple = strength > 0 ? Math.sin(phase) * strength * PITCH_MODULATION_DEPTH : 0;
        points.push({
          x,
          amplitude: clamp(level * MAX_AMPLITUDE * (1 + ripple), 0, CENTER_Y - 1),
        });
        phase += (2 * Math.PI * density) / (last * POINTS_PER_SLICE);
      }
    }
    return points;
  }

  /** Left half from the oldest edge to the centre, then the right half back out. */
  function targetPoints() {
    return [...halfPoints('left').reverse(), ...halfPoints('right').slice(1)];
  }

  function envelopePath(samples) {
    const upper = samples.map((point) => ({ x: point.x, y: CENTER_Y - point.amplitude }));
    const lower = samples.map((point) => ({ x: point.x, y: CENTER_Y + point.amplitude })).reverse();

    const upperPath = smoothPath(upper);
    const lowerPath = smoothPath(lower);
    if (!upperPath || !lowerPath) return '';
    return `${upperPath} L ${lower[0].x.toFixed(2)} ${lower[0].y.toFixed(2)} ${lowerPath.replace(/^M [^C]+/, '')} Z`;
  }

  function draw() {
    wave.setAttribute('d', envelopePath(drawn));
  }

  /** Moves the drawn band toward its target; stops once it has arrived. */
  function step(now) {
    frame = null;
    const targets = targetPoints();
    if (!drawn || drawn.length !== targets.length) drawn = targets.map((point) => ({ ...point, amplitude: 0 }));
    const elapsed = lastFrameAt === null ? 16 : Math.min(100, now - lastFrameAt);
    lastFrameAt = now;
    const blend = 1 - Math.exp(-elapsed / EASE_MS);
    let moving = false;
    drawn = drawn.map((point, index) => {
      const target = targets[index];
      const amplitude = point.amplitude + (target.amplitude - point.amplitude) * blend;
      const arrived = Math.abs(target.amplitude - amplitude) <= 0.05;
      if (!arrived) moving = true;
      return arrived ? target : { x: target.x, amplitude };
    });
    draw();
    if (moving) frame = animationFrame(step);
    else lastFrameAt = null;
  }

  function render(active) {
    meter.dataset.active = active ? 'true' : 'false';
    wave.style.opacity = active ? '0.9' : '0';
    if (!active || !animationFrame) {
      // Cleared at once; without frames (tests, background tabs) drawn as is.
      drawn = targetPoints();
      draw();
      return;
    }
    if (frame === null) frame = animationFrame(step);
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
