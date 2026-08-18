import { sendParticipantAuthentication } from './participant-auth.js';
await window.relayIdentityReady;

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
  let readinessRefreshTimer = null;
  let readinessRefreshInFlight = false;
  let diagnosticsSocket = null;
  let diagnosticsReconnect = null;
  const snapshots = new Map();

  const issueTitleKeys = {
    'audio-unavailable': 'system.attention.audio-unavailable',
    'robot-audio-unavailable': 'system.attention.robot-audio-unavailable',
    'robot-route-invalid': 'system.attention.robot-route-invalid',
    'robot-player-unavailable': 'system.attention.robot-player-unavailable',
    'song-clock-unavailable': 'system.attention.song-clock-unavailable',
    'mic-reconnecting': 'system.attention.mic-reconnecting',
    'mic-audio-stalled': 'system.attention.mic-audio-stalled',
    'timing-recovering': 'system.attention.timing-recovering',
    'timing-clamped': 'system.attention.timing-clamped',
    'take-failed': 'system.attention.take-failed',
  };

  function localeIsChinese() {
    return window.relayI18n?.getLocale?.() === 'zh-Hant';
  }

  function productCopy(english, traditionalChinese) {
    return localeIsChinese() ? traditionalChinese : english;
  }

  function causeCopy(cause) {
    const copy = {
      'backing-not-ready': ['Song audio is still getting ready.', '伴奏正在準備中。'],
      'backing-unavailable': ['Song audio is unavailable.', '伴奏目前無法使用。'],
      'backing-stalled': ['Song audio stopped arriving.', '伴奏音訊已停止送達。'],
      'backing-route-mismatch': ['The Robot backing route does not match the active mode.', 'Robot 伴奏路徑與目前模式不一致。'],
      'robot-source-unavailable': ['The Robot playback source is unavailable.', 'Robot 播放來源目前無法使用。'],
      'song-clock-unavailable': ['Shared song timing is unavailable.', '共用歌曲的時間資訊目前無法使用。'],
      'mic-transport-disconnected': ['The Mic connection was interrupted.', 'Mic 連線已中斷。'],
      'mic-audio-stalled': ['The Mic is connected, but audio stopped arriving.', 'Mic 仍連線，但音訊已停止送達。'],
      'timing-calibrating': ['Relay is measuring timing.', 'Relay 正在量測 Timing。'],
      'timing-fallback': ['Relay is using the network timing estimate for now.', '目前先使用網路 Timing 估計值。'],
      'timing-stale': ['Timing settings changed and the alignment is stale.', 'Timing 設定已改變，原本的對齊已過期。'],
      'timing-clamped': ['The required timing correction is outside the safe range.', '需要的 Timing 修正超出安全範圍。'],
      'recording-failed': ['The last recording did not finish successfully.', '上一段錄音沒有成功完成。'],
    }[cause];
    return copy ? productCopy(copy[0], copy[1]) : '';
  }

  function recoveryCopy(recovery) {
    const copy = {
      automatic: ['Relay is recovering automatically.', 'Relay 正在自動恢復。'],
      'retry-mic': ['Reconnect the Mic, then try again.', '重新連接 Mic 後再試一次。'],
      'retry-recording': ['Start a new recording when you are ready.', '準備好後重新錄一次。'],
      recalibrate: ['Run timing calibration again.', '重新校正 Timing。'],
      'host-service': ['The host service needs attention.', '需要處理主機端服務。'],
    }[recovery];
    return copy ? productCopy(copy[0], copy[1]) : '';
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
      ? `${productCopy('Affects', '影響')}：${affects.join(' · ')}`
      : '';
    const recovery = document.createElement('span');
    recovery.className = 'system-issue-recovery';
    recovery.textContent = recoveryCopy(issue?.recovery);
    meta.append(affected, recovery);

    card.append(heading, detail, meta);
    return card;
  }

  function renderProductSystem() {
    const product = latestProduct;
    if (!product) {
      healthyNode.hidden = false;
      healthyTitle.textContent = productCopy('Connecting…', '連線中…');
      healthyDetail.textContent = '';
      issuesNode.replaceChildren();
      return;
    }

    const issues = Array.isArray(product.issues) ? product.issues : [];
    if (issues.length === 0) {
      healthyNode.hidden = false;
      healthyTitle.textContent = productCopy('System normal', '系統正常');
      healthyDetail.textContent = productCopy('No current problems need your attention.', '目前沒有需要處理的問題。');
      issuesNode.replaceChildren();
      return;
    }

    healthyNode.hidden = true;
    issuesNode.replaceChildren(...issues.map(issueCard));
  }

  function text(id, value) {
    const node = document.querySelector(`#${id}`);
    if (node) node.textContent = value ?? '—';
  }

  function yesNo(value) {
    if (value === true) return 'Yes';
    if (value === false) return 'No';
    return '—';
  }

  function connection(connected, streaming) {
    if (!connected) return 'Disconnected';
    if (streaming === false) return 'Connected · quiet';
    if (streaming === true) return 'Streaming';
    return 'Connected';
  }

  function titleCase(value) {
    if (typeof value !== 'string' || !value) return '—';
    return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function routeLabel(mode) {
    if (mode === 'robot') return 'Robot';
    if (mode === 'legacy') return 'Legacy';
    if (mode === 'idle') return 'Idle';
    return '—';
  }

  function micSummary(product) {
    const mic = product?.room?.mic;
    if (!mic) return '—';
    if (mic.state === 'free') return t('system.micFree');
    const owner = mic.ownerNickname || t('voice.someone');
    if (mic.state === 'reconnecting') return t('system.micOwnerReconnecting', { name: owner });
    return t('system.micOwner', { name: owner });
  }

  function songSummary(product) {
    const song = product?.room?.song;
    if (!song) return '—';
    if (song.state === 'empty') return t('system.noSong');
    if (song.state === 'handoff') return t('system.songChangingPhones');
    if (song.state === 'unavailable') return t('system.unavailable');
    return titleCase(song.state);
  }

  function readyzUrl() {
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);
    const query = params.toString();
    return `/readyz${query ? `?${query}` : ''}`;
  }

  async function refreshReadiness() {
    if (readinessRefreshInFlight) return latestReadiness;
    readinessRefreshInFlight = true;
    try {
      const response = await fetch(readyzUrl(), { cache: 'no-store' });
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

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);
    const query = params.toString();
    return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
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
    diagnosticsState.textContent = 'Open to refresh';
  }

  function connectDiagnostics() {
    if (!diagnosticsPanel.open) return;
    if (
      diagnosticsSocket?.readyState === WebSocket.OPEN
      || diagnosticsSocket?.readyState === WebSocket.CONNECTING
    ) return;

    diagnosticsState.textContent = 'Refreshing…';
    const socket = new WebSocket(wsUrl());
    diagnosticsSocket = socket;

    socket.addEventListener('open', () => {
      if (diagnosticsSocket !== socket) return;
      diagnosticsState.textContent = 'Connected';
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
      diagnosticsState.textContent = diagnosticsPanel.open ? 'Reconnecting…' : 'Open to refresh';
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
    const components = readiness?.components ?? {};

    text('diag-overview-health', product ? titleCase(product.health) : '—');
    text('diag-overview-lifecycle', product ? titleCase(product.lifecycle) : '—');
    text('diag-overview-ready', readiness ? yesNo(readiness.ready) : '—');
    text('diag-overview-session-ready', readiness ? yesNo(readiness.sessionReady) : '—');

    text('diag-session-people', product ? String(Number(product.room?.participantCount) || 0) : '—');
    text('diag-session-mic', product ? micSummary(product) : '—');
    text('diag-session-song', product ? songSummary(product) : '—');
    text('diag-session-take', product ? titleCase(product.take?.lifecycle) : '—');

    text('diag-audio-route', routeLabel(components.route?.mode));
    text('diag-audio-backing', connection(components.backing?.connected, components.backing?.streaming));
    text('diag-audio-mic', connection(components.mic?.connected, components.mic?.streaming));
    text('diag-audio-mix', components.session ? (components.session.active ? 'Active' : 'Idle') : '—');

    text('diag-timing-product', product ? titleCase(product.timing?.state) : '—');
    text('diag-timing-player', components.player ? connection(components.player.timelineConnected) : '—');
    text('diag-timing-calibration', components.calibration
      ? `${titleCase(components.calibration.state)} · valid ${yesNo(components.calibration.valid)}`
      : '—');
    text('diag-timing-offset', components.player?.offsetFresh
      ? `${Math.round(Number(components.player.offsetMs) || 0)} ms`
      : components.player ? 'Not fresh' : '—');

    text('diag-robot-mode', routeLabel(components.route?.mode));
    text('diag-robot-source', components.robotSource ? connection(components.robotSource.connected) : '—');
    text('diag-robot-backing', components.backing
      ? `${connection(components.backing.connected, components.backing.streaming)}${components.backing.sampleRate ? ` · ${components.backing.sampleRate} Hz` : ''}`
      : '—');
    text('diag-robot-player', components.player
      ? `${connection(components.player.timelineConnected)} · offset fresh ${yesNo(components.player.offsetFresh)}`
      : '—');

    rawNode.textContent = JSON.stringify({
      product: product ?? null,
      readiness: readiness ?? null,
      session: session ?? null,
      source: source ?? null,
      timing: timing ?? null,
      take: take ?? null,
      timeline: timeline ?? null,
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
      copyButton.textContent = 'Copied';
    } catch {
      copyButton.textContent = 'Copy failed';
    }
    setTimeout(() => { copyButton.textContent = 'Copy diagnostics'; }, 1_400);
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

  window.addEventListener('beforeunload', () => {
    stopReadinessRefresh();
    closeDiagnosticsSocket();
  }, { once: true });

  renderProductSystem();
  renderDiagnostics();
}