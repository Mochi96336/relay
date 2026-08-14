const recordButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const recordingStatus = document.querySelector('#recording-status');
const recordingPlayer = document.querySelector('#recording-player');
const recordingDownload = document.querySelector('#download-recording');

const MIX_SAMPLE_RATE = 48000;
const SOCKET_RECONNECT_MS = 1000;
// Recording wants completeness, not low latency: hold a deep queue so a stall
// followed by the server's catch-up burst is written out rather than trimmed.
const RECORDER_PREBUFFER_MS = 350;
const RECORDER_MAX_QUEUE_MS = 8000;

let socket = null;
let socketReconnectTimer = null;
let transportActive = false;
let audioContext = null;
let playback = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingUrl = null;
let sourceSampleRate = null;
let publisherSampleRate = null;
let testActive = false;
let sourceConnected = false;
let sourceMicConnected = false;
let sourcePrebufferMs = 0;
let receivedPcmFrames = 0;
let receivedPcmSamples = 0;
let maxPcmAbs = 0;
let lastPcmStatusAt = 0;
let playbackHealth = null;
let transportDropouts = 0;
let serverMicStarvedFrames = 0;
let serverDroppedFrames = 0;

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = new URLSearchParams(location.search).get('key');
  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  return `${protocol}//${location.host}/ws${query}`;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed.')), { once: true });
  });
}

function int16ToFloat32(buffer) {
  const input = new Int16Array(buffer);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] / (input[i] < 0 ? 0x8000 : 0x7fff);
  }
  return output;
}

function linearResample(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;

  const ratio = targetRate / sourceRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = i / ratio;
    const index = Math.floor(sourcePosition);
    const fraction = sourcePosition - index;
    const a = input[Math.min(index, input.length - 1)];
    const b = input[Math.min(index + 1, input.length - 1)];
    output[i] = a + (b - a) * fraction;
  }

  return output;
}

function chooseMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function peakDbfs() {
  if (maxPcmAbs <= 0) return -100;
  return 20 * Math.log10(maxPcmAbs / 32768);
}

function isRecording() {
  return mediaRecorder?.state === 'recording';
}

function updateRecordingTransportStatus() {
  if (!isRecording()) return;

  if (!socket) {
    recordingStatus.textContent = '● 錄音中 · ⚠ Relay 連線中斷，正在重連 · 這段期間會錄到靜音';
    return;
  }

  if (receivedPcmFrames > 0) {
    const glitches = playbackHealth?.underruns > 0 ? ` · ${playbackHealth.underruns} 次緩衝不足` : '';
    const buffer = playbackHealth ? ` · buffer ${Math.round(playbackHealth.queuedMs)} ms` : '';
    recordingStatus.textContent = `● 錄音中 · Server PCM ${receivedPcmFrames} frames · peak ${peakDbfs().toFixed(1)} dBFS${buffer}${glitches}`;
    return;
  }

  if (sourceConnected && !sourceMicConnected) {
    recordingStatus.textContent = '● 錄音中 · Source 已連線 · Mic 未連線 / 正在重連 · Server 暫不輸出 PCM';
    return;
  }

  if (sourceConnected) {
    const prebuffer = sourcePrebufferMs > 0 ? ` · prebuffer ${sourcePrebufferMs} ms` : '';
    recordingStatus.textContent = `● 錄音中 · Source + Mic 已連線${prebuffer} · 等待第一個 Server PCM frame…`;
    return;
  }

  if (publisherSampleRate) {
    recordingStatus.textContent = `● 錄音中 · Mic ${publisherSampleRate} Hz 已連線 · 尚未收到 Server PCM`;
    return;
  }

  recordingStatus.textContent = '● 錄音中 · 尚未看到 Mic / Source 連線';
}

function clearSocketReconnect() {
  if (!socketReconnectTimer) return;
  clearTimeout(socketReconnectTimer);
  socketReconnectTimer = null;
}

function cleanupTransport() {
  transportActive = false;
  clearSocketReconnect();
  if (socket) {
    socket.close();
    socket = null;
  }
  if (playback) {
    try {
      playback.disconnect();
    } catch {}
    playback = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  sourceSampleRate = null;
  publisherSampleRate = null;
  testActive = false;
  sourceConnected = false;
  sourceMicConnected = false;
  sourcePrebufferMs = 0;
}

function describeQuality() {
  const notes = [];
  if (transportDropouts > 0) notes.push(`${transportDropouts} 次連線中斷`);
  if (playbackHealth?.underruns > 0) notes.push(`${playbackHealth.underruns} 次緩衝不足`);
  if (playbackHealth?.starvedMs > 30) notes.push(`約 ${Math.round(playbackHealth.starvedMs)} ms 靜音`);
  if (playbackHealth?.droppedMs > 30) notes.push(`裁掉 ${Math.round(playbackHealth.droppedMs)} ms`);
  if (serverMicStarvedFrames > 0) notes.push(`Server 人聲不足 ${serverMicStarvedFrames} frames`);
  if (serverDroppedFrames > 0) notes.push(`Server 丟棄 ${serverDroppedFrames} frames`);
  return notes.length > 0 ? ` · ⚠ ${notes.join(' / ')}` : '';
}

function finishRecording(mimeType) {
  const type = mediaRecorder?.mimeType || mimeType || 'audio/webm';
  const blob = new Blob(recordingChunks, { type });
  const frames = receivedPcmFrames;
  const samples = receivedPcmSamples;
  const peak = peakDbfs();
  const quality = describeQuality();

  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = URL.createObjectURL(blob);

  recordingPlayer.src = recordingUrl;
  recordingPlayer.hidden = false;

  const extension = type.includes('mp4') ? 'm4a' : 'webm';
  recordingDownload.href = recordingUrl;
  recordingDownload.download = `relay-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
  recordingDownload.hidden = false;

  if (frames === 0) {
    recordingStatus.textContent = `錄音完成 · ⚠ 沒收到任何 Server PCM · ${(blob.size / 1024).toFixed(0)} KB${quality}`;
  } else if (maxPcmAbs < 8) {
    recordingStatus.textContent = `錄音完成 · ⚠ 收到 ${frames} PCM frames，但幾乎全是靜音 · ${(blob.size / 1024).toFixed(0)} KB${quality}`;
  } else {
    recordingStatus.textContent = `錄音完成 · ${frames} PCM frames / ${samples} samples · peak ${peak.toFixed(1)} dBFS · ${(blob.size / 1024).toFixed(0)} KB${quality}`;
  }

  recordingChunks = [];
  mediaRecorder = null;
  cleanupTransport();
  recordButton.disabled = false;
  stopButton.disabled = true;
}

function handleJsonMessage(message) {
  if (message.type === 'publisher-status') {
    publisherSampleRate = message.sampleRate ?? null;
    if (!testActive) sourceSampleRate = publisherSampleRate;
    updateRecordingTransportStatus();
    return;
  }

  if (message.type === 'source-status') {
    sourceConnected = Boolean(message.connected);
    sourceMicConnected = Boolean(message.micConnected);
    sourcePrebufferMs = Number(message.prebufferMs) || 0;
    if (sourceConnected) sourceSampleRate = MIX_SAMPLE_RATE;
    updateRecordingTransportStatus();
    return;
  }

  if (message.type === 'mix-health') {
    serverMicStarvedFrames = Number(message.micStarvedFrames) || 0;
    serverDroppedFrames = Number(message.monitorDroppedFrames) || 0;
    return;
  }

  if (message.type === 'test-status') {
    testActive = Boolean(message.active);
    if (testActive) {
      sourceSampleRate = Number(message.sampleRate) || MIX_SAMPLE_RATE;
      playback?.port.postMessage({ type: 'reset' });
      const label = message.mode === 'tab-source'
        ? 'YouTube tab + Mic mix'
        : message.mode === 'youtube-backing'
          ? 'timecode follower'
          : `${message.bpm} BPM test`;
      recordingStatus.textContent = `● 錄音中 · Server mix · ${label}`;
    } else {
      // Never leave this null: a null rate used to make every arriving frame be
      // counted and then discarded, which looks identical to "no audio".
      sourceSampleRate = publisherSampleRate || MIX_SAMPLE_RATE;
      playback?.port.postMessage({ type: 'reset' });
      updateRecordingTransportStatus();
    }
  }
}

function handleBinaryMessage(data) {
  const pcm16 = new Int16Array(data);
  receivedPcmFrames += 1;
  receivedPcmSamples += pcm16.length;
  for (let i = 0; i < pcm16.length; i += 1) {
    maxPcmAbs = Math.max(maxPcmAbs, Math.abs(pcm16[i]));
  }

  const now = performance.now();
  if (now - lastPcmStatusAt >= 500) {
    lastPcmStatusAt = now;
    updateRecordingTransportStatus();
  }

  if (!audioContext || !playback) return;

  const rate = sourceSampleRate || MIX_SAMPLE_RATE;
  const pcm = int16ToFloat32(data);
  const samples = linearResample(pcm, rate, audioContext.sampleRate);
  playback.port.postMessage(samples.buffer, [samples.buffer]);
}

function scheduleReconnect() {
  if (!transportActive) return;
  clearSocketReconnect();
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectTransport().catch(() => scheduleReconnect());
  }, SOCKET_RECONNECT_MS);
}

async function connectTransport() {
  if (!transportActive) return;
  clearSocketReconnect();

  const ws = await connectSocket();
  if (!transportActive) {
    ws.close();
    return;
  }

  socket = ws;
  playback?.port.postMessage({ type: 'reset' });
  ws.send(JSON.stringify({ type: 'register', role: 'monitor' }));

  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;

    if (typeof event.data === 'string') {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleJsonMessage(message);
      return;
    }

    if (event.data instanceof ArrayBuffer) handleBinaryMessage(event.data);
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    if (!transportActive) return;
    // A dev-server restart, a tunnel hiccup or a heartbeat miss used to end the
    // take outright. Keep recording and reconnect; the gap is audible silence
    // and is reported in the summary.
    transportDropouts += 1;
    updateRecordingTransportStatus();
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {}
  });

  updateRecordingTransportStatus();
}

async function startRecording() {
  if (typeof MediaRecorder === 'undefined') {
    recordingStatus.textContent = '這個瀏覽器不支援 MediaRecorder。';
    return;
  }

  recordButton.disabled = true;
  stopButton.disabled = true;
  recordingStatus.textContent = '正在連線到 Server…';
  recordingPlayer.hidden = true;
  recordingDownload.hidden = true;
  recordingChunks = [];
  sourceConnected = false;
  sourceMicConnected = false;
  sourcePrebufferMs = 0;
  receivedPcmFrames = 0;
  receivedPcmSamples = 0;
  maxPcmAbs = 0;
  lastPcmStatusAt = 0;
  playbackHealth = null;
  transportDropouts = 0;
  serverMicStarvedFrames = 0;
  serverDroppedFrames = 0;

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/playback-worklet.js');
  await audioContext.resume();

  playback = new AudioWorkletNode(audioContext, 'playback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  playback.port.postMessage({
    type: 'configure',
    prebufferMs: RECORDER_PREBUFFER_MS,
    maxQueueMs: RECORDER_MAX_QUEUE_MS,
  });
  playback.port.onmessage = (event) => {
    if (event.data?.type === 'health') playbackHealth = event.data;
  };

  const recordingDestination = audioContext.createMediaStreamDestination();
  playback.connect(recordingDestination);

  transportActive = true;
  await connectTransport();

  const mimeType = chooseMimeType();
  mediaRecorder = new MediaRecorder(
    recordingDestination.stream,
    mimeType ? { mimeType } : undefined,
  );

  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) recordingChunks.push(event.data);
  });

  mediaRecorder.addEventListener('stop', () => finishRecording(mimeType), { once: true });
  mediaRecorder.start(1000);

  if (window.relayActiveRole === 'publisher') {
    recordingStatus.textContent =
      '● 錄音中 · ⚠ 這台裝置同時在當 Microphone。錄音要再下載整份 48 kHz 混音並即時編碼，'
      + '手機通常撐不住，聲音會斷斷續續。請改在電腦上錄。';
  } else {
    updateRecordingTransportStatus();
  }

  stopButton.disabled = false;
}

function stopRecording() {
  if (isRecording()) {
    stopButton.disabled = true;
    recordingStatus.textContent = '正在完成錄音…';
    transportActive = false;
    clearSocketReconnect();
    mediaRecorder.stop();
  }
}

recordButton.addEventListener('click', () => {
  startRecording().catch((error) => {
    console.error(error);
    cleanupTransport();
    mediaRecorder = null;
    recordingStatus.textContent = error instanceof Error ? error.message : String(error);
    recordButton.disabled = false;
    stopButton.disabled = true;
  });
});

stopButton.addEventListener('click', stopRecording);

recordButton.disabled = false;
stopButton.disabled = true;
