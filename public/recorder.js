const recordButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const recordingStatus = document.querySelector('#recording-status');
const recordingPlayer = document.querySelector('#recording-player');
const recordingDownload = document.querySelector('#download-recording');

const MIX_SAMPLE_RATE = 48000;

let socket = null;
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

function updateRecordingTransportStatus() {
  if (mediaRecorder?.state !== 'recording') return;

  if (receivedPcmFrames > 0) {
    recordingStatus.textContent = `● 錄音中 · Server PCM ${receivedPcmFrames} frames · peak ${peakDbfs().toFixed(1)} dBFS`;
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

function cleanupTransport() {
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

function finishRecording(mimeType) {
  const type = mediaRecorder?.mimeType || mimeType || 'audio/webm';
  const blob = new Blob(recordingChunks, { type });
  const frames = receivedPcmFrames;
  const samples = receivedPcmSamples;
  const peak = peakDbfs();

  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = URL.createObjectURL(blob);

  recordingPlayer.src = recordingUrl;
  recordingPlayer.hidden = false;

  const extension = type.includes('mp4') ? 'm4a' : 'webm';
  recordingDownload.href = recordingUrl;
  recordingDownload.download = `relay-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
  recordingDownload.hidden = false;

  if (frames === 0) {
    recordingStatus.textContent = `錄音完成 · ⚠ 沒收到任何 Server PCM · ${(blob.size / 1024).toFixed(0)} KB`;
  } else if (maxPcmAbs < 8) {
    recordingStatus.textContent = `錄音完成 · ⚠ 收到 ${frames} PCM frames，但幾乎全是靜音 · ${(blob.size / 1024).toFixed(0)} KB`;
  } else {
    recordingStatus.textContent = `錄音完成 · ${frames} PCM frames / ${samples} samples · peak ${peak.toFixed(1)} dBFS · ${(blob.size / 1024).toFixed(0)} KB`;
  }

  recordingChunks = [];
  mediaRecorder = null;
  cleanupTransport();
  recordButton.disabled = false;
  stopButton.disabled = true;
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

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/playback-worklet.js');
  await audioContext.resume();

  playback = new AudioWorkletNode(audioContext, 'playback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  const recordingDestination = audioContext.createMediaStreamDestination();
  playback.connect(recordingDestination);

  socket = await connectSocket();
  socket.send(JSON.stringify({ type: 'register', role: 'monitor' }));

  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data);

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
        if (sourceConnected && message.sampleRate) {
          sourceSampleRate = MIX_SAMPLE_RATE;
        }
        updateRecordingTransportStatus();
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
          sourceSampleRate = publisherSampleRate;
          playback?.port.postMessage({ type: 'reset' });
          updateRecordingTransportStatus();
        }
        return;
      }

      return;
    }

    if (!(event.data instanceof ArrayBuffer)) return;

    const pcm16 = new Int16Array(event.data);
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

    if (!sourceSampleRate || !audioContext || !playback) {
      recordingStatus.textContent = `● 錄音中 · 收到 PCM ${receivedPcmFrames} frames，但 sample rate 尚未建立`;
      return;
    }

    const pcm = int16ToFloat32(event.data);
    const samples = linearResample(pcm, sourceSampleRate, audioContext.sampleRate);
    playback.port.postMessage(samples.buffer, [samples.buffer]);
  });

  socket.addEventListener('close', () => {
    if (mediaRecorder?.state === 'recording') {
      recordingStatus.textContent = 'Relay 連線中斷，正在結束錄音…';
      mediaRecorder.stop();
    }
  });

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

  updateRecordingTransportStatus();
  stopButton.disabled = false;
}

function stopRecording() {
  if (mediaRecorder?.state === 'recording') {
    stopButton.disabled = true;
    recordingStatus.textContent = '正在完成錄音…';
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
