const systemPanel = document.querySelector('#system-panel');
const diagnosticsPanel = document.querySelector('#diagnostics-panel');
const attentionButton = document.querySelector('#attention-link');
const attentionRegion = document.querySelector('#system-attention');
const diagnosticsState = document.querySelector('#diagnostics-state');
const copyButton = document.querySelector('#copy-diagnostics');
const rawNode = document.querySelector('#diagnostics-raw');

const systemValues = {
  relay: document.querySelector('#system-relay'),
  phones: document.querySelector('#system-phones'),
  robot: document.querySelector('#system-robot'),
  audio: document.querySelector('#system-audio'),
  timing: document.querySelector('#system-timing'),
  recording: document.querySelector('#system-recording'),
};

const systemDetails = {
  relay: document.querySelector('#system-relay-detail'),
  phones: document.querySelector('#system-phones-detail'),
  robot: document.querySelector('#system-robot-detail'),
  audio: document.querySelector('#system-audio-detail'),
  timing: document.querySelector('#system-timing-detail'),
  recording: document.querySelector('#system-recording-detail'),
};

if (
  systemPanel && diagnosticsPanel && attentionButton && attentionRegion
  && diagnosticsState && copyButton && rawNode
  && Object.values(systemValues).every(Boolean)
  && Object.values(systemDetails).every(Boolean)
) {
  let latestProduct = null;
  let latestReadiness = null;
  let diagnosticsSocket = null;
  let diagnosticsReconnect = null;
  const snapshots = new Map();

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
    if (mic.state === 'free') return 'Mic free';
    const owner = mic.ownerNickname || 'Someone';
    if (mic.state === 'reconnecting') return `${owner} · reconnecting`;
    return `${owner} · live`;
  }

  function songSummary(product) {
    const song = product?.room?.song;
    if (!song) return '—';
    if (song.state === 'empty') return 'No song';
    if (song.state === 'handoff') return 'Changing phones';
    if (song.state === 'unavailable') return 'Unavailable';
    return titleCase(song.state);
  }

  function renderL2() {
    const product = latestProduct;
    if (!product) return;

    systemDetails.relay.textContent = `${titleCase(product.health)} · ${titleCase(product.lifecycle)} room state.`;
    const people = Number(product.room?.participantCount) || 0;
    systemDetails.phones.textContent = `${people} ${people === 1 ? 'person' : 'people'} online · ${micSummary(product)}.`;

    const audioAttention = product.attention?.scope === 'audio';
    const songAttention = product.attention?.scope === 'song';
    if (audioAttention) {
      systemValues.audio.textContent = 'Needs attention';
      systemDetails.audio.textContent = 'The room audio path is unavailable. Open Technical details for backing evidence.';
    } else if (songAttention) {
      systemValues.audio.textContent = 'Needs attention';
      systemDetails.audio.textContent = 'Song playback needs attention. Open Technical details for playback evidence.';
    } else {
      systemDetails.audio.textContent = `${songSummary(product)} · ${micSummary(product)}.`;
    }

    systemDetails.timing.textContent = product.timing?.state === 'idle'
      ? 'Timing stays out of the way until a performance needs it.'
      : `${titleCase(product.timing?.state)} timing state for the active performance.`;

    const take = product.take ?? {};
    systemDetails.recording.textContent = take.lifecycle === 'ready'
      ? `Last take ${take.verdict ? `· ${titleCase(take.verdict)}` : 'is ready'}.`
      : `${titleCase(take.lifecycle)} recording state.`;

    const route = latestReadiness?.components?.route?.mode;
    const robotAttention = product.attention?.scope === 'robot';
    if (robotAttention) {
      systemValues.robot.textContent = 'Needs attention';
      systemDetails.robot.textContent = 'The active Robot audio path has a problem. Open Technical details for evidence.';
    } else if (route === 'idle') {
      systemValues.robot.textContent = 'Idle';
      systemDetails.robot.textContent = 'The Robot route is not armed. Missing Robot audio is expected in this state.';
    } else if (route === 'legacy') {
      systemValues.robot.textContent = 'Legacy route';
      systemDetails.robot.textContent = 'This session is using the compatibility backing route rather than the formal Robot route.';
    } else if (route === 'robot') {
      systemValues.robot.textContent = 'Ready';
      systemDetails.robot.textContent = 'The formal Robot source and backing route are armed.';
    } else {
      systemValues.robot.textContent = product.lifecycle === 'idle' ? 'Idle' : 'OK';
      systemDetails.robot.textContent = 'No current Robot issue is surfaced by the product state.';
    }

    document.querySelectorAll('.system-item').forEach((item) => {
      const scope = item.dataset.systemScope;
      const attention = product.attention?.scope;
      const matches = scope === attention
        || (scope === 'phones' && attention === 'mic')
        || (scope === 'audio' && attention === 'song')
        || (scope === 'recording' && attention === 'take');
      item.dataset.attention = matches ? 'true' : 'false';
    });
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
    try {
      const response = await fetch(readyzUrl(), { cache: 'no-store' });
      const payload = await response.json();
      latestReadiness = payload;
      snapshots.set('readiness', payload);
      renderL2();
      renderDiagnostics();
      return payload;
    } catch {
      latestReadiness = null;
      renderL2();
      renderDiagnostics();
      return null;
    }
  }

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);

    const participantId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId.trim()
      : '';
    const nickname = typeof window.relayNickname === 'string'
      ? window.relayNickname.trim()
      : '';
    if (participantId && nickname) {
      params.set('participant', participantId);
      params.set('name', nickname);
    }

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
      requestDiagnostics(socket);
    });

    socket.addEventListener('message', (event) => {
      if (diagnosticsSocket !== socket || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message?.type || typeof message.type !== 'string') return;
      snapshots.set(message.type, message);
      if (message.type === 'product-status') latestProduct = message;
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

    const raw = {
      product: product ?? null,
      readiness: readiness ?? null,
      session: session ?? null,
      source: source ?? null,
      timing: timing ?? null,
      take: take ?? null,
      timeline: timeline ?? null,
    };
    rawNode.textContent = JSON.stringify(raw, null, 2);
  }

  function focusSystemScope(scope) {
    const map = {
      audio: 'audio',
      robot: 'robot',
      song: 'audio',
      mic: 'phones',
      timing: 'timing',
      take: 'recording',
    };
    const target = map[scope] ?? scope;
    const item = document.querySelector(`.system-item[data-system-scope="${target}"]`);
    if (item instanceof HTMLDetailsElement) item.open = true;
  }

  attentionButton.addEventListener('click', () => {
    focusSystemScope(attentionRegion.dataset.scope || '');
  });

  systemPanel.addEventListener('toggle', () => {
    if (systemPanel.open) refreshReadiness();
  });

  diagnosticsPanel.addEventListener('toggle', () => {
    if (diagnosticsPanel.open) {
      refreshReadiness();
      connectDiagnostics();
    } else {
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

  window.addEventListener('relay-product-status', (event) => {
    latestProduct = event.detail;
    snapshots.set('product-status', event.detail);
    renderL2();
    renderDiagnostics();
  });

  renderDiagnostics();
}
