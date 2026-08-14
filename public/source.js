const armButton = document.querySelector('#arm-source');
const stateNode = document.querySelector('#source-state');
const detailNode = document.querySelector('#source-detail');
const mirrorState = document.querySelector('#mirror-state');
const mirrorTimeline = document.querySelector('#mirror-timeline');
const captureState = document.querySelector('#capture-state');
const sourceVolume = document.querySelector('#source-volume');
const sourceVolumeValue = document.querySelector('#source-volume-value');
const sourceMicGain = document.querySelector('#source-mic-gain');
const sourceMicGainValue = document.querySelector('#source-mic-gain-value');
const timingButton = document.querySelector('#start-timing-calibration');
const timingStatus = document.querySelector('#timing-calibration-status');
const vocalFineTune = document.querySelector('#vocal-fine-tune');
const vocalFineTuneValue = document.querySelector('#vocal-fine-tune-value');

const STATE_NAMES = new Map([
  [-1, 'waiting'],
  [0, 'ended'],
  [1, 'playing'],
  [2, 'paused'],
  [3, 'buffering'],
  [5, 'cued'],
]);

let socket = null;
let reconnectTimer = null;
let player = null;
let playerReady = false;
let armed = false;
let latestTimeline = null;
let latestSourceStatus = null;
let latestCalibration = null;
let loadedVideoId = null;
let lastSeekAt = 0;
let applyTimer = null;

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = new URLSearchParams(location.search).get('key');
  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  return `${protocol}//${location.host}/ws${query}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function signed(value, suffix = '') {
  const number = Math.round(Number(value) || 0);
  return `${number > 0 ? '+' : ''}${number}${suffix}`;
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function safePlayerTime() {
  if (!playerReady || !player) return Number.NaN;
  try {
    return Number(player.getCurrentTime());
  } catch {
    return Number.NaN;
  }
}

function applyBalance() {
  const songLevel = Math.max(0, Math.min(100, Number(sourceVolume.value) || 0));
  const micGainDb = Math.max(0, Math.min(36, Number(sourceMicGain.value) || 0));

  sourceVolumeValue.value = `${Math.round(songLevel)}%`;
  sourceMicGainValue.value = `${micGainDb > 0 ? '+' : ''}${Math.round(micGainDb)} dB`;

  if (playerReady && player && armed) {
    try {
      player.setVolume(songLevel);
    } catch {}
  }

  if (armed) {
    send({ type: 'set-mix', micGainDb });
  }
}

function applyFineTune(sendToServer = true) {
  const valueMs = Math.max(-100, Math.min(100, Number(vocalFineTune.value) || 0));
  vocalFineTuneValue.value = signed(valueMs, ' ms');
  if (sendToServer) send({ type: 'set-vocal-fine-tune', valueMs });
}

function renderCalibration() {
  const sourceConnected = Boolean(latestSourceStatus?.connected);
  const micConnected = Boolean(latestSourceStatus?.micConnected);
  const phonePlaying = Boolean(latestTimeline?.connected) && Number(latestTimeline?.state) === 1;
  const collecting = latestCalibration?.state === 'collecting';
  timingButton.disabled = collecting || !sourceConnected || !micConnected || !phonePlaying;

  if (collecting) {
    const progress = Math.round((Number(latestCalibration.progress) || 0) * 100);
    timingButton.textContent = `Calibrating… ${progress}%`;
    timingStatus.textContent = `Collecting ${progress}% · 手機保持喇叭播放，先不要說話。`;
    return;
  }

  timingButton.textContent = 'Calibrate timing';

  if (latestCalibration?.state === 'complete') {
    const confidence = Number(latestCalibration.confidence);
    const windows = Array.isArray(latestCalibration.segmentLagsMs)
      ? latestCalibration.segmentLagsMs.map((value) => `${signed(value)} ms`).join(' / ')
      : '';
    timingStatus.textContent = `✓ Mic path ${signed(latestCalibration.micLagMs, ' ms')} · confidence ${Number.isFinite(confidence) ? confidence.toFixed(2) : '--'}${windows ? ` · windows ${windows}` : ''}`;
    return;
  }

  if (latestCalibration?.state === 'failed') {
    timingStatus.textContent = `Calibration failed · ${latestCalibration.error ?? 'signal not usable'}。`;
    return;
  }

  if (latestSourceStatus?.timingMode === 'acoustic-calibration') {
    timingStatus.textContent = `Applied acoustic calibration · Mic path ${signed(latestSourceStatus.calibratedMicLagMs, ' ms')} · fine tune ${signed(latestSourceStatus.vocalFineTuneMs, ' ms')}`;
    return;
  }

  if (!sourceConnected || !micConnected) {
    timingStatus.textContent = '先連上手機 Microphone 與 Chrome Source。';
  } else if (!phonePlaying) {
    timingStatus.textContent = '手機播放 YouTube 後即可按 Calibrate timing。';
  } else {
    timingStatus.textContent = `Ready · 目前先用 network estimate ${signed(latestSourceStatus?.micNetworkCompensationMs, ' ms')}。`;
  }
}

function renderTimeline() {
  const timeline = latestTimeline;
  const connected = Boolean(timeline?.connected);
  const videoId = typeof timeline?.videoId === 'string' ? timeline.videoId : null;
  const target = Number(timeline?.serverTime);
  const state = Number(timeline?.state);
  const current = safePlayerTime();
  const deltaMs = Number.isFinite(current) && Number.isFinite(target)
    ? (current - target) * 1000
    : Number.NaN;

  armButton.disabled = armed || !playerReady || !connected || !videoId;

  if (!connected || !videoId) {
    stateNode.textContent = 'Waiting for phone timeline';
    detailNode.textContent = '手機開始播放 YouTube 後，這裡會自動找到同一支影片。';
    mirrorState.textContent = 'waiting';
    mirrorTimeline.textContent = '--:-- · Δ -- ms';
    renderCalibration();
    return;
  }

  stateNode.textContent = armed ? 'Source armed' : 'Timeline ready';
  detailNode.textContent = `${videoId} · phone ${STATE_NAMES.get(state) ?? state} · target ${formatTime(target)}`;
  mirrorState.textContent = `${STATE_NAMES.get(state) ?? state}${armed ? ' · following' : ' · muted until enabled'}`;
  mirrorTimeline.textContent = `${formatTime(current)} / target ${formatTime(target)} · Δ ${Number.isFinite(deltaMs) ? `${Math.round(deltaMs)} ms` : '-- ms'}`;
  renderCalibration();
}

function applyTimeline() {
  const timeline = latestTimeline;
  if (!playerReady || !player || !timeline?.connected || !timeline.videoId) {
    renderTimeline();
    return;
  }

  const target = Number(timeline.serverTime);
  const desiredState = Number(timeline.state);
  if (!Number.isFinite(target)) return;

  try {
    if (loadedVideoId !== timeline.videoId) {
      player.cueVideoById({ videoId: timeline.videoId, startSeconds: Math.max(0, target) });
      loadedVideoId = timeline.videoId;
      lastSeekAt = performance.now();
      renderTimeline();
      return;
    }

    const current = safePlayerTime();
    const errorSeconds = Number.isFinite(current) ? current - target : Number.NaN;
    const now = performance.now();
    if (Number.isFinite(errorSeconds) && Math.abs(errorSeconds) > 0.45 && now - lastSeekAt > 700) {
      player.seekTo(Math.max(0, target), true);
      lastSeekAt = now;
    }

    if (!armed) {
      if (player.getPlayerState() === 1) player.pauseVideo();
      renderTimeline();
      return;
    }

    if (desiredState === 1) {
      if (player.getPlayerState() !== 1) player.playVideo();
    } else if (player.getPlayerState() === 1 || player.getPlayerState() === 3) {
      player.pauseVideo();
    }
  } catch (error) {
    console.warn('Could not apply source timeline', error);
  }

  renderTimeline();
}

function renderSourceStatus(message) {
  latestSourceStatus = message;
  const micState = message.micConnected ? 'Mic connected' : 'Mic disconnected';
  const timing = message.timingMode === 'acoustic-calibration'
    ? `calibrated ${signed(message.calibratedMicLagMs, ' ms')}`
    : `network ${signed(message.micNetworkCompensationMs, ' ms')}`;

  captureState.textContent = message.connected
    ? `● Capture connected · ${message.sampleRate ?? '--'} Hz · ${micState} · buffer ${message.prebufferMs ?? '--'} ms · timing ${timing}`
    : 'Capture not connected · click the Relay extension icon on this tab.';

  if (Number.isFinite(Number(message.vocalFineTuneMs))) {
    vocalFineTune.value = String(Number(message.vocalFineTuneMs));
    applyFineTune(false);
  }
  renderCalibration();
}

function connect() {
  clearTimeout(reconnectTimer);
  const next = new WebSocket(wsUrl());
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    send({ type: 'youtube-timeline-request' });
    send({ type: 'source-status-request' });
    send({ type: 'timing-calibration-status-request' });
    if (armed) applyBalance();
  });

  next.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'youtube-timeline-status') {
      latestTimeline = message;
      applyTimeline();
      return;
    }

    if (message.type === 'source-status') {
      renderSourceStatus(message);
      return;
    }

    if (message.type === 'timing-calibration-status') {
      latestCalibration = message;
      renderCalibration();
      return;
    }

    if (message.type === 'error') {
      timingStatus.textContent = message.message ?? 'Relay error.';
    }
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    latestTimeline = null;
    latestSourceStatus = null;
    renderTimeline();
    reconnectTimer = setTimeout(connect, 1_000);
  });

  next.addEventListener('error', () => next.close());
}

armButton.addEventListener('click', () => {
  armed = true;
  armButton.disabled = true;
  try {
    player?.unMute();
  } catch {}
  applyBalance();
  applyTimeline();
});

sourceVolume.addEventListener('input', applyBalance);
sourceMicGain.addEventListener('input', applyBalance);
vocalFineTune.addEventListener('input', () => applyFineTune(true));
timingButton.addEventListener('click', () => {
  if (!send({ type: 'start-timing-calibration' })) {
    timingStatus.textContent = 'Server 尚未連線。';
  }
});

window.onYouTubeIframeAPIReady = () => {
  player = new window.YT.Player('source-player', {
    height: '360',
    width: '640',
    playerVars: {
      playsinline: 1,
      controls: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        playerReady = true;
        renderTimeline();
        applyBalance();
        applyTimeline();
      },
      onStateChange: renderTimeline,
      onError: (event) => {
        stateNode.textContent = `YouTube source error ${event.data}`;
      },
    },
  });
};

const apiScript = document.createElement('script');
apiScript.src = 'https://www.youtube.com/iframe_api';
document.head.append(apiScript);

applyTimer = setInterval(applyTimeline, 250);
window.addEventListener('beforeunload', () => clearInterval(applyTimer), { once: true });
applyBalance();
applyFineTune(false);
renderTimeline();
connect();
