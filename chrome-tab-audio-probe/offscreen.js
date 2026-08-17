let stream = null;
let audioContext = null;
let source = null;
let captureNode = null;
let silentGain = null;
let relaySocket = null;
let relayReady = false;
let relayPageUrl = null;
let reconnectTimer = null;
let activeTabId = null;
let meterSumSquares = 0;
let meterSamples = 0;
let lastMeterAt = 0;
let droppedChunks = 0;
let lastDropWarningAt = 0;
// The offscreen document is disposable: Chrome may tear it down and later
// recreate it while Relay still retains the previous backing timeline. A
// module-local zero would therefore reuse generation 1 with sample cursor 0,
// making the new capture look like late data from the old incarnation. Seed
// each offscreen document independently so recreation is a fresh capture.
let captureGeneration = crypto.getRandomValues(new Uint32Array(1))[0];
let captureSampleCursor = 0;

// Byte layout is pinned by src/pcm-frame.ts and test/pcm-frame.test.ts. Each
// frame states where it belongs, so a chunk dropped here leaves a hole of the
// right length on the server instead of pulling all later audio earlier.
const FRAME_MAGIC = 0x4c52;
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 16;

function framePcm(pcm, generation, firstSampleIndex) {
  const frame = new ArrayBuffer(FRAME_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(frame);
  view.setUint16(0, FRAME_MAGIC, true);
  view.setUint8(2, FRAME_VERSION);
  view.setUint8(3, 0);
  view.setUint32(4, generation >>> 0, true);
  view.setFloat64(8, firstSampleIndex, true);
  new Uint8Array(frame, FRAME_HEADER_BYTES).set(new Uint8Array(pcm));
  return frame;
}

function relayWsUrl(pageUrl) {
  const url = new URL(pageUrl);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = url.searchParams.get('key');
  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  return `${protocol}//${url.host}/ws${query}`;
}

function relayInfrastructureKey(pageUrl) {
  const url = new URL(pageUrl);
  return new URLSearchParams(url.hash.slice(1)).get('infra') ?? '';
}

function reportState(state) {
  if (!Number.isInteger(activeTabId)) return;
  chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'relay-state',
    tabId: activeTabId,
    state,
  }).catch(() => {});
}

function closeRelay() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  relayReady = false;
  if (relaySocket) {
    const socket = relaySocket;
    relaySocket = null;
    try {
      socket.close();
    } catch {}
  }
}

function connectRelay() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  relayReady = false;
  if (!relayPageUrl || !audioContext || !Number.isInteger(activeTabId)) return;

  const socket = new WebSocket(relayWsUrl(relayPageUrl));
  relaySocket = socket;
  reportState('connecting');

  socket.addEventListener('open', () => {
    if (relaySocket !== socket || !audioContext) return;
    const infrastructureKey = relayInfrastructureKey(relayPageUrl);
    if (!/^[0-9a-f]{64}$/.test(infrastructureKey)) {
      console.error('Relay source page is missing a valid #infra= capability.');
      reportState('error');
      socket.close();
      return;
    }
    socket.send(JSON.stringify({
      type: 'infrastructure-authenticate',
      key: infrastructureKey,
    }));
  });

  socket.addEventListener('message', (event) => {
    if (relaySocket !== socket || typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'infrastructure-authenticated') {
      socket.send(JSON.stringify({
        type: 'register',
        role: 'backing',
        sampleRate: audioContext.sampleRate,
      }));
      return;
    }

    if (message.type === 'infrastructure-auth-rejected') {
      console.error('Relay rejected infrastructure capability:', message.message);
      reportState('error');
      return;
    }

    if (message.type === 'registered' && message.role === 'backing') {
      relayReady = true;
      reportState('sending');
      return;
    }

    if (message.type === 'error') {
      console.error('Relay rejected tab source:', message.message);
      reportState('error');
    }
  });

  socket.addEventListener('close', () => {
    if (relaySocket !== socket) return;
    relaySocket = null;
    relayReady = false;
    reportState('disconnected');
    if (stream && Number.isInteger(activeTabId)) {
      reconnectTimer = setTimeout(connectRelay, 1_000);
    }
  });

  socket.addEventListener('error', () => socket.close());
}

function handlePcm(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    if (buffer?.type === 'input-gap') {
      console.warn('Relay tab capture gap:', buffer.quanta, 'quanta padded with silence');
    }
    return;
  }

  const samples = new Int16Array(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const normalized = samples[i] / (samples[i] < 0 ? 32768 : 32767);
    meterSumSquares += normalized * normalized;
  }
  meterSamples += samples.length;

  const now = performance.now();
  if (now - lastMeterAt >= 250 && meterSamples > 0 && Number.isInteger(activeTabId)) {
    const rms = Math.sqrt(meterSumSquares / meterSamples);
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -100;
    chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'audio-level',
      tabId: activeTabId,
      dbfs,
      sending: relayReady,
    }).catch(() => {});
    meterSumSquares = 0;
    meterSamples = 0;
    lastMeterAt = now;
  }

  // Advance for every captured chunk, sent or not, and keep counting across a
  // relay reconnect so the stream rejoins the timeline it already had.
  const firstSampleIndex = captureSampleCursor;
  captureSampleCursor += samples.length;

  if (!relayReady || relaySocket?.readyState !== WebSocket.OPEN) return;

  if (relaySocket.bufferedAmount >= 512 * 1024) {
    droppedChunks += 1;
    const now = performance.now();
    if (now - lastDropWarningAt > 2_000) {
      lastDropWarningAt = now;
      console.warn(`Relay uplink congested: dropped ${droppedChunks} chunks (~${droppedChunks * 20} ms).`);
      if (Number.isInteger(activeTabId)) {
        chrome.runtime.sendMessage({
          target: 'service-worker',
          type: 'uplink-congested',
          tabId: activeTabId,
          droppedChunks,
        }).catch(() => {});
      }
    }
    return;
  }

  relaySocket.send(framePcm(buffer, captureGeneration, firstSampleIndex));
}

async function stopCapture(notify = false) {
  closeRelay();

  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  try {
    captureNode?.disconnect();
  } catch {}
  try {
    silentGain?.disconnect();
  } catch {}
  try {
    source?.disconnect();
  } catch {}
  captureNode = null;
  silentGain = null;
  source = null;

  if (audioContext) {
    await audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (notify && Number.isInteger(activeTabId)) {
    chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'capture-ended',
      tabId: activeTabId,
    }).catch(() => {});
  }

  relayPageUrl = null;
  meterSumSquares = 0;
  meterSamples = 0;
  droppedChunks = 0;
  lastDropWarningAt = 0;
  activeTabId = null;
}

async function startCapture(streamId, tabId, pageUrl) {
  await stopCapture(false);
  activeTabId = tabId;
  relayPageUrl = pageUrl;

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const [audioTrack] = stream.getAudioTracks();
  if (!audioTrack) throw new Error('Captured tab stream has no audio track.');
  audioTrack.addEventListener('ended', () => stopCapture(true), { once: true });

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'));
  await audioContext.resume();

  captureGeneration = (captureGeneration + 1) >>> 0;
  captureSampleCursor = 0;

  source = audioContext.createMediaStreamSource(stream);
  captureNode = new AudioWorkletNode(audioContext, 'relay-tab-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  captureNode.port.onmessage = (event) => handlePcm(event.data);

  // tabCapture removes this tab from Chrome's normal output. Route the captured
  // stream back to the speakers while a second silent branch produces PCM.
  source.connect(audioContext.destination);
  source.connect(captureNode).connect(silentGain).connect(audioContext.destination);

  connectRelay();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'start-capture') {
    startCapture(message.streamId, message.tabId, message.pageUrl).catch(async (error) => {
      console.error('Relay tab source failed', error);
      const tabId = message.tabId;
      await stopCapture(false);
      chrome.runtime.sendMessage({
        target: 'service-worker',
        type: 'capture-ended',
        tabId,
      }).catch(() => {});
    });
    return;
  }

  if (message.type === 'stop-capture') {
    stopCapture(false).catch(() => {});
  }
});
