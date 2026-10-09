import { DIAGNOSTICS_MESSAGES } from './diagnostics-copy.js';
import { sendParticipantAuthentication } from './participant-auth.js';
import { wsUrl } from './ws-url.js';

// Registered here as well as by system-details.js: whichever module loads
// first must find the copy, and identical registrations are no-ops.
window.relayI18n?.registerMessages?.(DIAGNOSTICS_MESSAGES);
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;

const REFRESH_MS = 1_000;
let initialized = false;

function initialize() {
  if (initialized) return;
  const diagnosticsPanel = document.querySelector('#diagnostics-panel');
  if (!diagnosticsPanel) return;

  const nodes = {
    applied: document.querySelector('#diag-calibration-applied'),
    pathState: document.querySelector('#diag-path-state'),
    pathCorrelations: document.querySelector('#diag-path-correlations'),
    pathDifference: document.querySelector('#diag-path-difference'),
    effective: document.querySelector('#diag-path-effective'),
    contentState: document.querySelector('#diag-content-state'),
    contentProgress: document.querySelector('#diag-content-progress'),
    contentAgreement: document.querySelector('#diag-content-agreement'),
    contentCandidate: document.querySelector('#diag-content-candidate'),
    contentConfidence: document.querySelector('#diag-content-confidence'),
    contentLevels: document.querySelector('#diag-content-levels'),
    contentSegments: document.querySelector('#diag-content-segments'),
    validation: document.querySelector('#diag-content-validation'),
    validationLast: document.querySelector('#diag-content-validation-last'),
  };
  if (Object.values(nodes).some((node) => node === null)) return;
  initialized = true;
  let latestTiming = null;

  let socket = null;
  let reconnectTimer = null;
  let refreshTimer = null;

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function ms(value) {
    const number = finite(value);
    if (number === null) return '—';
    const rounded = Math.round(number);
    return `${rounded > 0 ? '+' : ''}${rounded} ms`;
  }

  function confidence(value) {
    const number = finite(value);
    return number === null ? '—' : number.toFixed(2);
  }

  function dbfs(value) {
    const number = finite(value);
    return number === null ? '—' : `${number.toFixed(1)} dBFS`;
  }

  function title(value) {
    if (typeof value !== 'string' || !value) return '—';
    return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  /** A server enum in the current locale; an unknown value still reads as words. */
  function named(group, value) {
    if (typeof value !== 'string' || !value) return '—';
    const key = `diag.cal.${group}.${value}`;
    const text = t(key);
    return text === key ? title(value) : text;
  }

  function micSong(mic, song) {
    return t('diag.cal.micSong', { mic, song });
  }

  function render(timing) {
    if (!timing || typeof timing !== 'object') return;
    latestTiming = timing;

    const applied = finite(timing.appliedMicAdvanceMs);
    const requested = finite(timing.requestedMicAdvanceMs);
    nodes.applied.textContent = applied === null && requested === null
      ? '—'
      : `${ms(applied)} / ${ms(requested)}`;

    const contentActive = timing.calibrationKind === 'content';
    nodes.contentState.textContent = contentActive ? named('phase', timing.state) : t('diag.cal.notRunning');
    const progress = finite(timing.progress);
    nodes.contentProgress.textContent = contentActive && progress !== null
      ? `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`
      : '—';

    const agreed = finite(timing.windowsAgreed);
    const needed = finite(timing.windowsNeeded);
    nodes.contentAgreement.textContent = contentActive && agreed !== null && needed !== null
      ? `${t('diag.cal.windows', { agreed: Math.round(agreed), needed: Math.round(needed) })}${timing.provisional === true ? ` · ${t('diag.cal.provisional')}` : ''}`
      : '—';
    nodes.contentCandidate.textContent = contentActive ? ms(timing.micLagMs) : '—';
    nodes.contentConfidence.textContent = contentActive ? confidence(timing.confidence) : '—';
    nodes.contentLevels.textContent = contentActive
      ? micSong(dbfs(timing.micLevelDbfs), dbfs(timing.backingLevelDbfs))
      : '—';
    nodes.contentSegments.textContent = contentActive && Array.isArray(timing.segmentLagsMs)
      && timing.segmentLagsMs.length > 0
      ? timing.segmentLagsMs.map(ms).join(' · ')
      : '—';

    const validation = timing.validation;
    if (validation && typeof validation === 'object') {
      const parts = [named('validationState', validation.state), t('diag.cal.baseline', { ms: ms(validation.baselineLagMs) })];
      if (finite(validation.suspectLagMs) !== null) parts.push(t('diag.cal.suspect', { ms: ms(validation.suspectLagMs) }));
      const next = finite(validation.nextValidationInMs);
      if (next !== null) parts.push(t('diag.cal.nextIn', { seconds: Math.round(next / 1000) }));
      nodes.validation.textContent = parts.join(' · ');
      const measured = finite(validation.lastMeasuredLagMs);
      const delta = finite(validation.lastDeltaMs);
      nodes.validationLast.textContent = measured === null
        ? '—'
        : `${ms(measured)} · ${t('diag.cal.delta', { ms: ms(delta) })} · ${named('outcome', validation.lastOutcome)}`;
    } else {
      nodes.validation.textContent = '—';
      nodes.validationLast.textContent = '—';
    }

    const boot = timing.bootCalibration;
    const probeActive = timing.probeActive === true;
    nodes.pathState.textContent = probeActive
      ? `${named('probe', timing.probePhase)} · ${named('kind', timing.calibrationKind)}`
      : t(boot ? 'diag.cal.pathComplete' : 'diag.cal.pathIdle');

    const correlations = timing.probeCorrelation;
    nodes.pathCorrelations.textContent = correlations && typeof correlations === 'object'
      ? micSong(confidence(correlations.mic), confidence(correlations.backing))
      : '—';

    let pathDifference = null;
    if (boot && typeof boot === 'object') {
      const micLatency = finite(boot.micLatencyMs);
      const backingLatency = finite(boot.backingLatencyMs);
      pathDifference = micLatency !== null && backingLatency !== null
        ? micLatency - backingLatency
        : null;
      nodes.pathDifference.textContent = pathDifference === null
        ? '—'
        : t('diag.cal.pathMicSong', { difference: ms(pathDifference), mic: ms(micLatency), song: ms(backingLatency) });
    } else {
      nodes.pathDifference.textContent = '—';
    }

    const liveDelta = finite(timing.robotPlayerOffsetMs);
    nodes.effective.textContent = boot && pathDifference !== null && liveDelta !== null
      ? t('diag.cal.effectiveValue', { ms: ms(pathDifference + liveDelta), confidence: confidence(boot.confidence) })
      : boot ? t('diag.cal.pathReady') : '—';
  }

  function request() {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'timing-calibration-status-request' }));
    }
  }

  function stop() {
    if (refreshTimer !== null) clearInterval(refreshTimer);
    refreshTimer = null;
    const current = socket;
    socket = null;
    if (current) {
      try { current.close(); } catch {}
    }
  }

  function scheduleReconnect() {
    if (!diagnosticsPanel.open || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  }

  function connect() {
    if (!diagnosticsPanel.open || typeof WebSocket !== 'function') return;
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;

    const next = new WebSocket(wsUrl());
    socket = next;
    next.addEventListener('open', () => {
      if (socket !== next) return;
      sendParticipantAuthentication(next);
      request();
      refreshTimer = setInterval(request, REFRESH_MS);
    });
    next.addEventListener('message', (event) => {
      if (socket !== next || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type === 'timing-calibration-status') render(message);
    });
    next.addEventListener('close', () => {
      if (socket !== next) return;
      stop();
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });
  }

  diagnosticsPanel.addEventListener('toggle', () => {
    if (diagnosticsPanel.open) connect();
    else stop();
  });
  window.addEventListener('relay-locale-changed', () => render(latestTiming));
  if (diagnosticsPanel.open) connect();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}
