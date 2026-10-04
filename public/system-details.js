import './live-i18n.js';
import { sendParticipantAuthentication } from './participant-auth.js';
import { DIAGNOSTICS_MESSAGES } from './diagnostics-copy.js';
import {
  describeAudio,
  describeOverview,
  describeRobot,
  describeSession,
  describeTiming,
} from './diagnostics-model.js';
import { describeMicTransport } from './mic-diagnostics-model.js';
import { wsUrl } from './ws-url.js';
await window.relayIdentityReady;

window.relayI18n?.registerMessages?.(DIAGNOSTICS_MESSAGES);

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const systemPanel = document.querySelector('#system-panel');
const systemSheet = systemPanel?.querySelector('.system-sheet');
const diagnosticsPanel = document.querySelector('#diagnostics-panel');
const diagnosticsState = document.querySelector('#diagnostics-state');
const copyButton = document.querySelector('#copy-diagnostics');
const rawNode = document.querySelector('#diagnostics-raw');

if (
  systemPanel && systemSheet && diagnosticsPanel
  && diagnosticsState && copyButton && rawNode
) {
  const READINESS_REFRESH_MS = 1_000;
  let latestProduct = null;
  let latestReadiness = null;
  let latestStatusz = null;
  let readinessRefreshTimer = null;
  let readinessRefreshInFlight = false;
  let diagnosticsSocket = null;
  let diagnosticsReconnect = null;
  const snapshots = new Map();

  function rememberPlaybackDiagnostics(detail) {
    if (!detail || typeof detail !== 'object') return;
    snapshots.set('playback-client', detail);
    if (detail.kind === 'telemetry-rejected') {
      snapshots.set('playback-client-last-rejection', detail);
    }
  }

  rememberPlaybackDiagnostics(window.relayPlaybackDiagnostics);

  const issueTitleKeys = {
    'audio-unavailable': 'system.attention.audio-unavailable',
    'robot-audio-unavailable': 'system.attention.robot-audio-unavailable',
    'robot-route-invalid': 'system.attention.robot-route-invalid',
    'robot-player-unavailable': 'system.attention.robot-player-unavailable',
    'song-clock-unavailable': 'system.attention.song-clock-unavailable',
    'mic-reconnecting': 'system.attention.mic-reconnecting',
    'mic-audio-stalled': 'system.attention.mic-audio-stalled',
    'mic-input-clipping': 'system.attention.mic-input-clipping',
    'mic-too-loud': 'system.attention.mic-too-loud',
    'mic-too-quiet': 'system.attention.mic-too-quiet',
    'timing-recovering': 'system.attention.timing-recovering',
    'timing-clamped': 'system.attention.timing-clamped',
    'take-failed': 'system.attention.take-failed',
  };

  const issueCauseKeys = {
    'backing-not-ready': 'system.issue.cause.backing-not-ready',
    'backing-unavailable': 'system.issue.cause.backing-unavailable',
    'backing-stalled': 'system.issue.cause.backing-stalled',
    'backing-route-mismatch': 'system.issue.cause.backing-route-mismatch',
    'robot-source-unavailable': 'system.issue.cause.robot-source-unavailable',
    'robot-video-unplayable': 'system.issue.cause.robot-video-unplayable',
    'song-clock-unavailable': 'system.issue.cause.song-clock-unavailable',
    'mic-transport-disconnected': 'system.issue.cause.mic-transport-disconnected',
    'mic-audio-stalled': 'system.issue.cause.mic-audio-stalled',
    'mic-audio-intermittent': 'system.issue.cause.mic-audio-intermittent',
    'mic-timeline-behind': 'system.issue.cause.mic-timeline-behind',
    'mic-input-clipping': 'system.issue.cause.mic-input-clipping',
    'mic-too-loud': 'system.issue.cause.mic-too-loud',
    'mic-too-quiet': 'system.issue.cause.mic-too-quiet',
    'timing-calibrating': 'system.issue.cause.timing-calibrating',
    'timing-fallback': 'system.issue.cause.timing-fallback',
    'timing-stale': 'system.issue.cause.timing-stale',
    'timing-clamped': 'system.issue.cause.timing-clamped',
    'mic-frontier-lagging': 'system.issue.cause.mic-frontier-lagging',
    'recording-failed': 'system.issue.cause.recording-failed',
  };

  const issueRecoveryKeys = {
    automatic: 'system.issue.recovery.automatic',
    'retry-mic': 'system.issue.recovery.retry-mic',
    'adjust-input': 'system.issue.recovery.adjust-input',
    'lower-mic-gain': 'system.issue.recovery.lower-mic-gain',
    'raise-mic-gain': 'system.issue.recovery.raise-mic-gain',
    'retry-recording': 'system.issue.recovery.retry-recording',
    recalibrate: 'system.issue.recovery.recalibrate',
    'host-service': 'system.issue.recovery.host-service',
    'change-song': 'system.issue.recovery.change-song',
  };

  function causeCopy(cause) {
    const key = issueCauseKeys[cause];
    return key ? t(key) : '';
  }

  function recoveryCopy(recovery) {
    const key = issueRecoveryKeys[recovery];
    return key ? t(key) : '';
  }

  function impactLabel(impact) {
    if (impact === 'song') return t('song.label');
    if (impact === 'voice') return t('voice.label');
    if (impact === 'recording') return t('system.recording');
    if (impact === 'timing') return t('system.timing');
    return impact;
  }

  const productSurface = document.createElement('section');
  productSurface.id = 'system-product';
  productSurface.className = 'system-product';
  productSurface.setAttribute('aria-live', 'polite');

  const healthyNode = document.createElement('div');
  healthyNode.className = 'system-healthy';
  const healthyTitle = document.createElement('strong');
  const healthyDetail = document.createElement('span');
  healthyNode.append(healthyTitle, healthyDetail);

  const issuesNode = document.createElement('div');
  issuesNode.id = 'system-product-issues';
  issuesNode.className = 'system-product-issues';
  productSurface.append(healthyNode, issuesNode);
  systemSheet.insertBefore(productSurface, diagnosticsPanel);

  function canRetryMicHere(issue) {
    const participantId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId
      : null;
    return issue?.recovery === 'retry-mic'
      && participantId !== null
      && latestProduct?.room?.mic?.ownerId === participantId;
  }

  function issueCard(issue) {
    const card = document.createElement('article');
    card.className = 'system-issue';
    card.dataset.severity = issue?.severity === 'critical' ? 'critical' : 'warning';

    const heading = document.createElement('strong');
    const titleKey = issueTitleKeys[issue?.code];
    heading.textContent = titleKey ? t(titleKey) : t('system.attention');

    const detail = document.createElement('p');
    detail.textContent = causeCopy(issue?.cause);

    const meta = document.createElement('div');
    meta.className = 'system-issue-meta';
    const affects = Array.isArray(issue?.affects)
      ? issue.affects.map(impactLabel).filter(Boolean)
      : [];
    const affected = document.createElement('span');
    affected.textContent = affects.length > 0
      ? `${t('system.issue.affects')}：${affects.join(' · ')}`
      : '';
    const recovery = document.createElement('span');
    recovery.className = 'system-issue-recovery';
    recovery.textContent = recoveryCopy(issue?.recovery);
    meta.append(affected, recovery);

    if (canRetryMicHere(issue)) {
      const retryMic = document.createElement('button');
      retryMic.type = 'button';
      retryMic.className = 'system-issue-retry-mic text-action';
      retryMic.textContent = t('system.issue.action.retry-mic');
      retryMic.addEventListener('click', () => {
        // This stays a real user gesture. listen.js claims iOS play-and-record
        // synchronously before app.js replaces the old stream through the
        // ordinary Mic lifecycle.
        window.dispatchEvent(new CustomEvent('relay-retry-microphone'));
      });
      meta.append(retryMic);
    }

    card.append(heading, detail, meta);
    return card;
  }

  function renderProductSystem() {
    const product = latestProduct;
    if (!product) {
      healthyNode.hidden = false;
      healthyTitle.textContent = t('system.product.connecting');
      healthyDetail.textContent = '';
      issuesNode.replaceChildren();
      return;
    }

    const issues = Array.isArray(product.issues) ? product.issues : [];
    if (issues.length === 0) {
      healthyNode.hidden = false;
      healthyTitle.textContent = t('system.product.normal');
      healthyDetail.textContent = t('system.product.noProblems');
      issuesNode.replaceChildren();
      return;
    }

    healthyNode.hidden = true;
    issuesNode.replaceChildren(...issues.map(issueCard));
  }

  /**
   * Shows a copy key on a node the locale switch also rewrites. i18n's
   * applyStatic() re-renders every [data-i18n] from the attribute, so the
   * attribute has to carry the current state, not the markup's initial one.
   */
  function showCopy(node, key) {
    node.dataset.i18n = key;
    node.textContent = t(key);
  }

  /** One described row: a value, an optional plain-language note and a tone. */
  function describedValue(node, described) {
    const value = document.createElement('span');
    value.className = 'diagnostic-value';
    value.textContent = described.value ?? '—';
    const parts = [value];
    if (described.note) {
      const note = document.createElement('span');
      note.className = 'diagnostic-note';
      note.textContent = described.note;
      parts.push(note);
    }
    node.dataset.tone = described.tone ?? 'neutral';
    node.replaceChildren(...parts);
  }

  /** Technical details renders every tab the same way: model rows into a ledger. */
  function renderLedger(id, rows) {
    const ledger = document.querySelector(`#${id}`);
    if (!ledger) return;
    ledger.replaceChildren(...rows.map((described) => {
      const pair = document.createElement('div');
      pair.className = 'diagnostic-pair';
      pair.dataset.row = described.key;
      const label = document.createElement('dt');
      label.textContent = described.label;
      const value = document.createElement('dd');
      describedValue(value, described);
      pair.append(label, value);
      return pair;
    }));
  }

  function readyzUrl() {
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);
    const query = params.toString();
    return `/readyz${query ? `?${query}` : ''}`;
  }

  function statuszUrl() {
    return readyzUrl().replace('/readyz', '/statusz');
  }

  /**
   * Mic transport evidence lives on /statusz, not in any pushed message: it
   * is counters and windows that only make sense sampled while someone is
   * looking. Refreshed on the readiness cadence, only while Technical details
   * is open.
   */
  async function refreshStatusz() {
    try {
      const response = await fetch(statuszUrl(), { cache: 'no-store' });
      latestStatusz = await response.json();
    } catch {
      latestStatusz = null;
    }
  }

  async function refreshReadiness() {
    if (readinessRefreshInFlight) return latestReadiness;
    readinessRefreshInFlight = true;
    try {
      const [response] = await Promise.all([
        fetch(readyzUrl(), { cache: 'no-store' }),
        refreshStatusz(),
      ]);
      const payload = await response.json();
      latestReadiness = payload;
      snapshots.set('readiness', payload);
      renderDiagnostics();
      return payload;
    } catch {
      latestReadiness = null;
      renderDiagnostics();
      return null;
    } finally {
      readinessRefreshInFlight = false;
    }
  }

  function stopReadinessRefresh() {
    if (readinessRefreshTimer) clearInterval(readinessRefreshTimer);
    readinessRefreshTimer = null;
  }

  function startReadinessRefresh() {
    if (!diagnosticsPanel.open) return;
    void refreshReadiness();
    if (readinessRefreshTimer) return;
    readinessRefreshTimer = setInterval(() => {
      if (!diagnosticsPanel.open) {
        stopReadinessRefresh();
        return;
      }
      void refreshReadiness();
    }, READINESS_REFRESH_MS);
  }

  function requestDiagnostics(socket) {
    for (const type of [
      'product-status-request',
      'session-status-request',
      'source-status-request',
      'timing-calibration-status-request',
      'take-status-request',
      'youtube-timeline-request',
    ]) {
      socket.send(JSON.stringify({ type }));
    }
  }

  function scheduleDiagnosticsReconnect() {
    if (!diagnosticsPanel.open || diagnosticsReconnect) return;
    diagnosticsReconnect = setTimeout(() => {
      diagnosticsReconnect = null;
      connectDiagnostics();
    }, 1_000);
  }

  function closeDiagnosticsSocket() {
    if (diagnosticsReconnect) clearTimeout(diagnosticsReconnect);
    diagnosticsReconnect = null;
    const socket = diagnosticsSocket;
    diagnosticsSocket = null;
    if (socket) {
      try { socket.close(); } catch {}
    }
    showCopy(diagnosticsState, 'diag.state.openToRefresh');
  }

  function connectDiagnostics() {
    if (!diagnosticsPanel.open) return;
    if (
      diagnosticsSocket?.readyState === WebSocket.OPEN
      || diagnosticsSocket?.readyState === WebSocket.CONNECTING
    ) return;

    showCopy(diagnosticsState, 'diag.state.refreshing');
    const socket = new WebSocket(wsUrl());
    diagnosticsSocket = socket;

    socket.addEventListener('open', () => {
      if (diagnosticsSocket !== socket) return;
      showCopy(diagnosticsState, 'diag.state.connected');
      sendParticipantAuthentication(socket);
      requestDiagnostics(socket);
    });

    socket.addEventListener('message', (event) => {
      if (diagnosticsSocket !== socket || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message?.type || typeof message.type !== 'string') return;
      snapshots.set(message.type, message);
      if (message.type === 'product-status') {
        latestProduct = message;
        renderProductSystem();
      }
      renderDiagnostics();
    });

    socket.addEventListener('close', () => {
      if (diagnosticsSocket !== socket) return;
      diagnosticsSocket = null;
      showCopy(diagnosticsState, diagnosticsPanel.open ? 'diag.state.reconnecting' : 'diag.state.openToRefresh');
      scheduleDiagnosticsReconnect();
    });
    socket.addEventListener('error', () => {
      try { socket.close(); } catch {}
    });
  }

  function renderDiagnostics() {
    const product = latestProduct ?? snapshots.get('product-status');
    const readiness = latestReadiness ?? snapshots.get('readiness');
    const session = snapshots.get('session-status');
    const source = snapshots.get('source-status');
    const timing = snapshots.get('timing-calibration-status');
    const take = snapshots.get('take-status');
    const timeline = snapshots.get('youtube-timeline-status');
    const playbackClient = snapshots.get('playback-client');
    const playbackClientLastRejection = snapshots.get('playback-client-last-rejection');
    const facts = { product, readiness, source, statusz: latestStatusz };

    renderLedger('diag-overview-ledger', describeOverview(facts, t));
    renderLedger('diag-session-ledger', describeSession(facts, t));
    renderLedger('diag-mic-ledger', describeMicTransport(latestStatusz, t));
    renderLedger('diag-audio-ledger', describeAudio(facts, t));
    renderLedger('diag-timing-ledger', describeTiming(facts, t));
    renderLedger('diag-robot-ledger', describeRobot(facts, t));

    rawNode.textContent = JSON.stringify({
      product: product ?? null,
      readiness: readiness ?? null,
      session: session ?? null,
      source: source ?? null,
      timing: timing ?? null,
      take: take ?? null,
      timeline: timeline ?? null,
      playbackClient: playbackClient ?? null,
      playbackClientLastRejection: playbackClientLastRejection ?? null,
      statusz: latestStatusz ?? null,
    }, null, 2);
  }

  diagnosticsPanel.addEventListener('toggle', () => {
    if (diagnosticsPanel.open) {
      startReadinessRefresh();
      connectDiagnostics();
    } else {
      stopReadinessRefresh();
      closeDiagnosticsSocket();
    }
  });

  document.querySelectorAll('[data-diagnostics-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset.diagnosticsTab;
      document.querySelectorAll('[data-diagnostics-tab]').forEach((candidate) => {
        candidate.setAttribute('aria-selected', candidate === button ? 'true' : 'false');
      });
      document.querySelectorAll('[data-diagnostics-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.diagnosticsPanel !== tab;
      });
    });
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rawNode.textContent || '{}');
      showCopy(copyButton, 'diag.copied');
    } catch {
      showCopy(copyButton, 'diag.copyFailed');
    }
    setTimeout(() => { showCopy(copyButton, 'diag.copy'); }, 1_400);
  });

  window.addEventListener('relay-locale-changed', () => {
    renderProductSystem();
    renderDiagnostics();
  });

  window.addEventListener('relay-product-status', (event) => {
    latestProduct = event.detail;
    snapshots.set('product-status', event.detail);
    renderProductSystem();
    renderDiagnostics();
  });

  window.addEventListener('relay:playback-diagnostics', (event) => {
    rememberPlaybackDiagnostics(event.detail);
    renderDiagnostics();
  });

  window.addEventListener('beforeunload', () => {
    stopReadinessRefresh();
    closeDiagnosticsSocket();
  }, { once: true });

  renderProductSystem();
  renderDiagnostics();
}
