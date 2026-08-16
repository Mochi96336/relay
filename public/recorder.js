const recordButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const recordingStatus = document.querySelector('#recording-status');
const recordingPlayer = document.querySelector('#recording-player');
const recordingDownload = document.querySelector('#download-recording');

const RECONNECT_MS = 1_000;

let socket = null;
let reconnectTimer = null;
let latestStatus = { lifecycle: 'idle', take: null };
let commandError = null;

function wsUrl() {
  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId
    : '';
  if (!participantId) return null;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);
  params.set('participant', participantId);
  params.set('name', typeof window.relayNickname === 'string' ? window.relayNickname : 'Guest');
  return `${protocol}//${location.host}/ws?${params.toString()}`;
}

function artifactUrl(relativeUrl) {
  const url = new URL(relativeUrl, location.origin);
  const key = new URLSearchParams(location.search).get('key');
  if (key) url.searchParams.set('key', key);
  return url.toString();
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function shortTakeId(takeId) {
  return typeof takeId === 'string' ? takeId.slice(0, 8) : '—';
}

function render() {
  const lifecycle = String(latestStatus?.lifecycle ?? 'idle');
  const take = latestStatus?.take ?? null;
  const connected = socket?.readyState === WebSocket.OPEN;

  recordButton.disabled = !connected || lifecycle === 'recording' || lifecycle === 'finalizing';
  stopButton.disabled = !connected || lifecycle !== 'recording' || !take?.takeId;

  if (lifecycle !== 'ready') {
    recordingPlayer.hidden = true;
    recordingPlayer.removeAttribute('src');
    recordingDownload.hidden = true;
    recordingDownload.removeAttribute('href');
  }

  if (!connected && lifecycle === 'idle') {
    recordingStatus.textContent = '正在連線到 Relay TakeSession…';
    return;
  }

  if (commandError) {
    recordingStatus.textContent = `⚠ ${commandError}`;
    return;
  }

  if (lifecycle === 'recording' && take) {
    recordingStatus.textContent = `● Relay 正在錄 Take ${shortTakeId(take.takeId)} · WAV 直接寫在 Server；這支手機只負責 Start / Stop。`;
    return;
  }

  if (lifecycle === 'finalizing' && take) {
    recordingStatus.textContent = `正在完成 Take ${shortTakeId(take.takeId)} 的 WAV…`;
    return;
  }

  if (lifecycle === 'ready' && take?.artifact) {
    const href = artifactUrl(take.artifact.url);
    recordingPlayer.src = href;
    recordingPlayer.hidden = false;
    recordingDownload.href = href;
    recordingDownload.download = take.artifact.fileName;
    recordingDownload.textContent = `Download ${take.artifact.fileName}`;
    recordingDownload.hidden = false;
    recordingStatus.textContent = `Take ${shortTakeId(take.takeId)} 完成 · ${formatDuration(take.artifact.durationMs)} · 48 kHz mono WAV · ${(Number(take.artifact.sizeBytes) / 1024).toFixed(0)} KB`;
    return;
  }

  if (lifecycle === 'failed' && take) {
    recordingStatus.textContent = `Take ${shortTakeId(take.takeId)} 失敗 · ${take.error || 'WAV writer failed'}`;
    return;
  }

  recordingStatus.textContent = connected
    ? 'Relay TakeSession 待命；先載入歌曲並讓 Source mix 啟動，再按 Record。'
    : 'Relay TakeSession 重新連線中…';
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) {
    commandError = 'Relay 連線中斷，尚未送出 Take 指令。';
    render();
    return false;
  }
  commandError = null;
  socket.send(JSON.stringify(payload));
  return true;
}

function clearReconnect() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(scheduleReconnect);
  }, RECONNECT_MS);
}

async function connect() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const url = wsUrl();
  if (!url) {
    scheduleReconnect();
    return;
  }

  clearReconnect();
  const next = new WebSocket(url);
  socket = next;
  render();

  await new Promise((resolve, reject) => {
    next.addEventListener('open', resolve, { once: true });
    next.addEventListener('error', reject, { once: true });
  });

  if (socket !== next) {
    next.close();
    return;
  }

  next.addEventListener('message', (event) => {
    if (socket !== next || typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'take-status') {
      latestStatus = message;
      commandError = null;
      render();
      return;
    }

    if (message.type === 'take-command-rejected') {
      const reasons = {
        'participant-required': 'Take 指令需要 Relay participant identity。',
        'mix-not-active': 'Source mix 還沒啟動，現在沒有 authoritative mix 可以錄。',
        'song-required': '先載入一首歌，再開始 Take。',
        'take-active': '已經有一個 Take 正在錄音或收尾。',
        'take-not-recording': '目前沒有正在錄的 Take。',
        'stale-take': '這個 Stop 屬於較舊的 Take，已忽略。',
        'invalid-take-id': 'Stop Take 缺少有效的 Take ID。',
        'writer-failed': 'Relay 無法建立 WAV writer。',
        'storage-unavailable': 'Relay 錄音磁碟空間不足，或 Take 儲存目錄目前不可用。',
      };
      commandError = reasons[message.reason] ?? `Take 指令被拒絕：${message.reason ?? 'unknown'}`;
      render();
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    render();
    scheduleReconnect();
  });
  next.addEventListener('error', () => {
    try { next.close(); } catch {}
  });

  next.send(JSON.stringify({ type: 'take-status-request' }));
  render();
}

recordButton.addEventListener('click', () => {
  send({ type: 'start-take' });
});

stopButton.addEventListener('click', () => {
  const takeId = latestStatus?.take?.takeId;
  if (!takeId) return;
  send({ type: 'stop-take', takeId });
});

recordButton.disabled = true;
stopButton.disabled = true;
render();
connect().catch(scheduleReconnect);