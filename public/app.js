const publisherButton = document.querySelector('#start-publisher');
const monitorButton = document.querySelector('#start-monitor');
const stopButton = document.querySelector('#stop');
const testStartButton = document.querySelector('#start-sync-test');
const testStopButton = document.querySelector('#stop-sync-test');
const status = document.querySelector('#status');
const details = document.querySelector('#details');
const monitorGain = document.querySelector('#monitor-gain');
const monitorGainValue = document.querySelector('#monitor-gain-value');
const micGain = document.querySelector('#mic-gain');
const micGainValue = document.querySelector('#mic-gain-value');
const voiceOffset = document.querySelector('#voice-offset');
const voiceOffsetValue = document.querySelector('#voice-offset-value');

const TEST_BPM = 120;
const MIX_SAMPLE_RATE = 48000;

let socket = null;
let audioContext = null;
let mediaStream = null;
let activeNode = null;
let monitorGainNode = null;
let sourceSampleRate = null;
let activeRole = null;
let testActive = false;
let clickScheduler = null;
let nextClickTime = 0;
let clickBeat = 0;
let rawMonitorGainDb = 30;

function setStatus(title, body = '') {
  status.textContent = title;
  details.textContent = body;
}

function dbToGain(db) {
  return 10 ** (db / 20);
}

function signed(value, suffix) {
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number}${suffix}`;
}

function updateMonitorGain() {
  const db = Number(monitorGain.value);
  monitorGainValue.value = signed(db, ' dB');
  if (!testActive) rawMonitorGainDb = db;
  if (monitorGainNode && audioContext) {
    monitorGainNode.gain.setTargetAtTime(dbToGain(db), audioContext.currentTime, 0.01);
  }
}

function updateMixLabels() {
  micGainValue.value = signed(micGain.value, ' dB');
  voiceOffsetValue.value = signed(voiceOffset.value, ' ms');
}

function sendMixSettings() {
  updateMixLabels();
  if (socket?.readyState !== WebSocket.OPEN || !activeRole) return;
  socket.send(JSON.stringify({
    type: 'set-mix',
    micGainDb: Number(micGain.value),
    voiceOffsetMs: Number(voiceOffset.value),
  }));
}

function updateTestButtons() {
  testStartButton.disabled = activeRole !== 'publisher' || testActive;
  testStopButton.disabled = !activeRole || !testActive;
  micGain.disabled = !activeRole;
  voiceOffset.disabled = !activeRole;
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

function scheduleClick(time, accent) {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = accent ? 1500 : 1000;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.15, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(time);
  oscillator.stop(time + 0.06);
}

function startLocalClickTrack() {
  stopLocalClickTrack();
  if (!audioContext || activeRole !== 'publisher') return;

  const beatSeconds = 60 / TEST_BPM;
  nextClickTime = audioContext.currentTime + 0.12;
  clickBeat = 0;

  const scheduleAhead = () => {
    if (!audioContext) return;
    while (nextClickTime < audioContext.currentTime + 0.15) {
      scheduleClick(nextClickTime, clickBeat % 4 === 0);
      nextClickTime += beatSeconds;
      clickBeat += 1;
    }
  };

  scheduleAhead();
  clickScheduler = setInterval(scheduleAhead, 25);
}

function stopLocalClickTrack() {
  if (clickScheduler) {
    clearInterval(clickScheduler);
    clickScheduler = null;
  }
}

function handleServerMessage(message, playback = null) {
  if (message.type === 'error') {
    setStatus('Error', message.message);
    return;
  }

  if (message.type === 'publisher-status') {
    if (!testActive) sourceSampleRate = message.sampleRate ?? null;
    if (activeRole === 'monitor') {
      if (!message.connected) {
        playback?.port.postMessage({ type: 'reset' });
        setStatus('Waiting for singer', 'Open this page on the phone and start the microphone.');
      } else if (!testActive) {
        setStatus('Singer connected', `Raw input: ${message.sampleRate} Hz · buffering audio…`);
      }
    }
    return;
  }

  if (message.type === 'mix-settings') {
    micGain.value = String(message.micGainDb ?? 30);
    voiceOffset.value = String(message.voiceOffsetMs ?? 0);
    updateMixLabels();
    return;
  }

  if (message.type === 'test-status') {
    const wasActive = testActive;
    testActive = Boolean(message.active);

    if (testActive) {
      sourceSampleRate = Number(message.sampleRate) || MIX_SAMPLE_RATE;
      if (activeRole === 'monitor') {
        playback?.port.postMessage({ type: 'reset' });
        monitorGain.value = '0';
        updateMonitorGain();
        setStatus('Sync test running', `${message.bpm} BPM · server mix · ${message.prebufferMs} ms safety buffer`);
      }
    } else {
      if (wasActive && activeRole === 'monitor') {
        playback?.port.postMessage({ type: 'reset' });
        monitorGain.value = String(rawMonitorGainDb);
        updateMonitorGain();
      }
      if (activeRole === 'publisher') stopLocalClickTrack();
    }

    updateTestButtons();
  }
}

async function stop(setIdle = true) {
  stopLocalClickTrack();
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
  monitorGainNode = null;
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  sourceSampleRate = null;
  activeRole = null;
  testActive = false;
  publisherButton.disabled = false;
  monitorButton.disabled = false;
  stopButton.disabled = true;
  updateTestButtons();
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
  activeRole = 'publisher';
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
    handleServerMessage(JSON.parse(event.data));
  });

  socket.addEventListener('close', () => setStatus('Disconnected', 'The relay connection closed.'));

  publisherButton.disabled = true;
  monitorButton.disabled = true;
  stopButton.disabled = false;
  updateTestButtons();
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
  monitorGainNode = audioContext.createGain();
  monitorGainNode.gain.value = dbToGain(Number(monitorGain.value));
  playback.connect(monitorGainNode).connect(audioContext.destination);
  activeNode = playback;

  playback.port.onmessage = (event) => {
    if (event.data?.type === 'buffering') setStatus('Monitor buffering…', 'Waiting for enough audio.');
    if (event.data?.type === 'playing' && !testActive) {
      setStatus('Monitor playing', `Output: ${audioContext.sampleRate} Hz · gain ${monitorGainValue.value}`);
    }
  };

  socket = await connectSocket();
  activeRole = 'monitor';
  socket.send(JSON.stringify({ type: 'register', role: 'monitor' }));

  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      handleServerMessage(JSON.parse(event.data), playback);
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
  updateTestButtons();
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

testStartButton.addEventListener('click', () => {
  if (activeRole !== 'publisher' || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'start-sync-test' }));
  startLocalClickTrack();
});

testStopButton.addEventListener('click', () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'stop-sync-test' }));
  stopLocalClickTrack();
});

monitorGain.addEventListener('input', updateMonitorGain);
micGain.addEventListener('input', sendMixSettings);
voiceOffset.addEventListener('input', sendMixSettings);

updateMonitorGain();
updateMixLabels();
updateTestButtons();
setStatus('Idle', 'On the phone choose Microphone; on the computer choose Monitor.');
