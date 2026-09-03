import { sendParticipantAuthentication } from './participant-auth.js';

const REFRESH_MS = 1_000;
let initialized = false;

function initialize() {
  if (initialized) return;
  const diagnosticsPanel = document.querySelector('#diagnostics-panel');
  const timingPanel = document.querySelector('[data-diagnostics-panel="timing"]');
  if (!diagnosticsPanel || !timingPanel) return;
  initialized = true;

  const heading = document.createElement('h4');
  heading.className = 'diagnostics-subheading';
  heading.textContent = 'Calibration measurements';

  const ledger = document.createElement('dl');
  ledger.className = 'diagnostic-ledger';

  function pair(label, id) {
    const row = document.createElement('div');
    row.className = 'diagnostic-pair';
    const term = document.createElement('dt');
    term.textContent = label;
    const value = document.createElement('dd');
    value.id = id;
    value.textContent = '—';
    row.append(term, value);
    ledger.append(row);
    return value;
  }

  const nodes = {
    applied: pair('Applied / requested', 'diag-calibration-applied'),
    contentState: pair('Content state', 'diag-content-state'),
    contentProgress: pair('Content progress', 'diag-content-progress'),
    contentAgreement: pair('Content agreement', 'diag-content-agreement'),
    contentCandidate: pair('Content candidate', 'diag-content-candidate'),
    contentConfidence: pair('Content confidence', 'diag-content-confidence'),
    contentLevels: pair('Content levels', 'diag-content-levels'),
    contentSegments: pair('Content segments', 'diag-content-segments'),
    validation: pair('Runtime validation', 'diag-content-validation'),
    validationLast: pair('Validation last measure', 'diag-content-validation-last'),
    pathState: pair('Path probe', 'diag-path-state'),
    pathCorrelations: pair('Probe correlations', 'diag-path-correlations'),
    pathDifference: pair('Path difference', 'diag-path-difference'),
    playerDelta: pair('Player delta', 'diag-path-player-delta'),
    effective: pair('Effective calibration', 'diag-path-effective'),
  };

  timingPanel.append(heading, ledger);

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

  function render(timing) {
    if (!timing || typeof timing !== 'object') return;

    const applied = finite(timing.appliedMicAdvanceMs);
    const requested = finite(timing.requestedMicAdvanceMs);
    nodes.applied.textContent = applied === null && requested === null
      ? '—'
      : `${ms(applied)} / ${ms(requested)}`;

    const contentActive = timing.calibrationKind === 'content';
    nodes.contentState.textContent = contentActive ? title(timing.state) : 'Not running';
    const progress = finite(timing.progress);
    nodes.contentProgress.textContent = contentActive && progress !== null
      ? `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`
      : '—';

    const agreed = finite(timing.windowsAgreed);
    const needed = finite(timing.windowsNeeded);
    nodes.contentAgreement.textContent = contentActive && agreed !== null && needed !== null
      ? `${Math.round(agreed)} / ${Math.round(needed)} windows${timing.provisional === true ? ' · provisional' : ''}`
      : '—';
    nodes.contentCandidate.textContent = contentActive ? ms(timing.micLagMs) : '—';
    nodes.contentConfidence.textContent = contentActive ? confidence(timing.confidence) : '—';
    nodes.contentLevels.textContent = contentActive
      ? `Mic ${dbfs(timing.micLevelDbfs)} · Song ${dbfs(timing.backingLevelDbfs)}`
      : '—';
    nodes.contentSegments.textContent = contentActive && Array.isArray(timing.segmentLagsMs)
      && timing.segmentLagsMs.length > 0
      ? timing.segmentLagsMs.map(ms).join(' · ')
      : '—';

    const validation = timing.validation;
    if (validation && typeof validation === 'object') {
      const baseline = ms(validation.baselineLagMs);
      const suspect = finite(validation.suspectLagMs) === null ? '' : ` · suspect ${ms(validation.suspectLagMs)}`;
      const next = finite(validation.nextValidationInMs);
      nodes.validation.textContent = `${title(validation.state)} · baseline ${baseline}${suspect}${next === null ? '' : ` · next ${Math.round(next / 1000)} s`}`;
      const measured = finite(validation.lastMeasuredLagMs);
      const delta = finite(validation.lastDeltaMs);
      nodes.validationLast.textContent = measured === null
        ? '—'
        : `${ms(measured)} · Δ ${ms(delta)} · ${title(validation.lastOutcome)}`;
    } else {
      nodes.validation.textContent = '—';
      nodes.validationLast.textContent = '—';
    }

    const boot = timing.bootCalibration;
    const probeActive = timing.probeActive === true;
    nodes.pathState.textContent = probeActive
      ? `${title(timing.probePhase)} · ${title(timing.calibrationKind)}`
      : boot ? 'Complete' : 'Idle';

    const correlations = timing.probeCorrelation;
    nodes.pathCorrelations.textContent = correlations && typeof correlations === 'object'
      ? `Mic ${confidence(correlations.mic)} · Song ${confidence(correlations.backing)}`
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
        : `${ms(pathDifference)} · Mic ${ms(micLatency)} · Song ${ms(backingLatency)}`;
    } else {
      nodes.pathDifference.textContent = '—';
    }

    const liveDelta = finite(timing.robotPlayerOffsetMs);
    nodes.playerDelta.textContent = liveDelta === null ? 'Waiting for playback' : ms(liveDelta);
    nodes.effective.textContent = boot && pathDifference !== null && liveDelta !== null
      ? `${ms(pathDifference + liveDelta)} · confidence ${confidence(boot.confidence)}`
      : boot ? 'Path ready · waiting for playback' : '—';
  }

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);
    const query = params.toString();
    return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
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
  if (diagnosticsPanel.open) connect();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}
