const publisherButton = document.querySelector('#start-publisher');
const monitorButton = document.querySelector('#start-monitor');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');
const details = document.querySelector('#details');

let socket = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let sourceSampleRate = null;

function setStatus(title, body = '') {
  status.textContent = title;
  details.textContent = body;
}

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

function int16ToFloat32(buffer) {
  const input = new Int16Array(buffer);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] / (input[i] < 0 ? 0x8000 : 0x7fff);
  }
  return output;
}

async function stop(setIdle = true) {
  if (socket) {
    socket.close();
    socket = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (activeNode) {
    try {
      activeNode.disconnect();
    } catch {}
    activeNode = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  sourceSampleRate = null;
  publisherButton.disabled = false;
  monitorButton.disabled = false;
  stopButton.disabled = true;
  if (setIdle) setStatus('Idle', 'Choose one role on each device.');
}

async function startPublisher() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable. On a phone, open Relay through HTTPS.');
  }
  await stop();
  setStatus('Starting microphone…');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/capture-worklet.js');
  await audioContext.resume();

  socket = await connectSocket();
  socket.send(JSON.stringify({
    type: 'register',
    role: 'publisher',
    sampleRate: audioContext.sampleRate,
  }));

  const source = audioContext.createMediaStreamSource(mediaStream);
  const capture = new AudioWorkletNode(audioContext, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silent = audioContext.createGain();
  silent.gain.value = 0;

  capture.port.onmessage = (event) => {
    if (
      socket?.readyState === WebSocket.OPEN &&
      socket.bufferedAmount < 256 * 1024 &&
      event.data instanceof ArrayBuffer
    ) {
      socket.send(event.data);
    }
  };

  source.connect(capture).connect(silent).connect(audioContext.destination);
  activeNode = capture;

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data);
    if (message.type === 'error') setStatus('Error', message.message);
  });

  socket.addEventListener('close', () => setStatus('Disconnected', 'The relay connection closed.'));

  publisherButton.disabled = true;
  monitorButton.disabled = true;
  stopButton.disabled = false;
  setStatus('Microphone is live', `${audioContext.sampleRate} Hz mono PCM → relay`);
}

async function startMonitor() {
  await stop();
  setStatus('Starting monitor…');

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/playback-worklet.js');
  await audioContext.resume();

  const playback = new AudioWorkletNode(audioContext, 'playback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  playback.connect(audioContext.destination);
  activeNode = playback;

  playback.port.onmessage = (event) => {
    if (event.data?.type === 'buffering') setStatus('Monitor buffering…', 'Waiting for enough microphone audio.');
    if (event.data?.type === 'playing') setStatus('Monitor playing', `Output: ${audioContext.sampleRate} Hz`);
  };

  socket = await connectSocket();
  socket.send(JSON.stringify({ type: 'register', role: 'monitor' }));

  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data);
      if (message.type === 'publisher-status') {
        sourceSampleRate = message.sampleRate ?? null;
        if (!message.connected) {
          playback.port.postMessage({ type: 'reset' });
          setStatus('Waiting for singer', 'Open this page on the phone and start the microphone.');
        } else {
          setStatus('Singer connected', `Input: ${sourceSampleRate} Hz · buffering audio…`);
        }
      }
      return;
    }

    if (!(event.data instanceof ArrayBuffer) || !sourceSampleRate) return;
    const pcm = int16ToFloat32(event.data);
    const samples = linearResample(pcm, sourceSampleRate, audioContext.sampleRate);
    playback.port.postMessage(samples.buffer, [samples.buffer]);
  });

  socket.addEventListener('close', () => setStatus('Disconnected', 'The relay connection closed.'));

  publisherButton.disabled = true;
  monitorButton.disabled = true;
  stopButton.disabled = false;
}

publisherButton.addEventListener('click', () => {
  startPublisher().catch(async (error) => {
    console.error(error);
    setStatus('Could not start microphone', error instanceof Error ? error.message : String(error));
    await stop(false);
  });
});

monitorButton.addEventListener('click', () => {
  startMonitor().catch(async (error) => {
    console.error(error);
    setStatus('Could not start monitor', error instanceof Error ? error.message : String(error));
    await stop(false);
  });
});

stopButton.addEventListener('click', () => {
  stop().catch(console.error);
});

setStatus('Idle', 'On the phone choose Microphone; on the computer choose Monitor.');
