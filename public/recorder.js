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
}

function finishRecording(mimeType) {
  const type = mediaRecorder?.mimeType || mimeType || 'audio/webm';
  const blob = new Blob(recordingChunks, { type });

  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = URL.createObjectURL(blob);

  recordingPlayer.src = recordingUrl;
  recordingPlayer.hidden = false;

  const extension = type.includes('mp4') ? 'm4a' : 'webm';
  recordingDownload.href = recordingUrl;
  recordingDownload.download = `relay-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
  recordingDownload.hidden = false;

  recordingStatus.textContent = `錄音完成 · ${(blob.size / 1024).toFixed(0)} KB · 可直接回放`;
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
        if (!message.connected) {
          recordingStatus.textContent = '● 錄音中 · 等待手機 Microphone';
        }
        return;
      }

      if (message.type === 'test-status') {
        testActive = Boolean(message.active);
        if (testActive) {
          sourceSampleRate = Number(message.sampleRate) || MIX_SAMPLE_RATE;
          playback?.port.postMessage({ type: 'reset' });
          recordingStatus.textContent = `● 錄音中 · Server mix · ${message.bpm} BPM`;
        } else {
          sourceSampleRate = publisherSampleRate;
          playback?.port.postMessage({ type: 'reset' });
          recordingStatus.textContent = '● 錄音中 · Server microphone';
        }
        return;
      }

      return;
    }

    if (!(event.data instanceof ArrayBuffer) || !sourceSampleRate || !audioContext || !playback) return;

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

  recordingStatus.textContent = '● 錄音中 · 正在錄 Server 輸出';
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
