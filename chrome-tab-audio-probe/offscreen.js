let stream = null;
let audioContext = null;
let source = null;
let analyser = null;
let meterTimer = null;
let activeTabId = null;

async function stopCapture(notify = false) {
  clearInterval(meterTimer);
  meterTimer = null;

  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  try {
    source?.disconnect();
  } catch {}
  source = null;
  analyser = null;

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

  activeTabId = null;
}

function startMeter() {
  const samples = new Float32Array(analyser.fftSize);

  meterTimer = setInterval(() => {
    if (!analyser || !Number.isInteger(activeTabId)) return;

    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i += 1) {
      sumSquares += samples[i] * samples[i];
    }

    const rms = Math.sqrt(sumSquares / samples.length);
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -100;

    chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'audio-level',
      tabId: activeTabId,
      dbfs,
    }).catch(() => {});
  }, 250);
}

async function startCapture(streamId, tabId) {
  await stopCapture(false);
  activeTabId = tabId;

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
  await audioContext.resume();

  source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;

  // tabCapture removes the tab from normal playback. Reconnect it so the
  // user keeps hearing exactly what Chrome is capturing during the probe.
  source.connect(analyser);
  source.connect(audioContext.destination);

  startMeter();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'start-capture') {
    startCapture(message.streamId, message.tabId).catch(async (error) => {
      console.error('Tab audio probe failed', error);
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
