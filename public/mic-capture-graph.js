export function parseMicVisualAnalysis(payload) {
  const rawSpectrumBands = Array.isArray(payload?.spectrumBands)
    ? payload.spectrumBands.slice(0, 5).map(Number)
    : [];
  const spectrumBands = rawSpectrumBands.length === 5 && rawSpectrumBands.every(Number.isFinite)
    ? rawSpectrumBands
    : null;
  const rawF0Hz = payload?.f0Hz;
  const f0Hz = rawF0Hz === null ? null : Number(rawF0Hz);
  const pitchConfidence = Number(payload?.pitchConfidence);
  if (
    spectrumBands === null
    || (f0Hz !== null && !Number.isFinite(f0Hz))
    || !Number.isFinite(pitchConfidence)
    || pitchConfidence < 0
    || pitchConfidence > 1
  ) return null;
  return { spectrumBands, f0Hz, pitchConfidence };
}


function trackDeviceId(track) {
  try {
    const id = track?.getSettings?.().deviceId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch { return null; }
}

/** Graph-local resources only. Publisher owns tracks, context and recovery policy. */
export function createMicCaptureGraph({
  epoch, sessionEpoch, stream, context, isCurrent, onCaptureMessage,
  onProcessorError, onInputDeviceChanged, onInputDeviceRemoved,
  // Local file mode puts its mix between the Mic and the capture. Returns a
  // handle with disconnect(), or null to capture the Mic alone.
  connectInput = null,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioWorkletNodeClass = globalThis.AudioWorkletNode,
  WorkerClass = globalThis.Worker,
  warn = (...args) => console.warn(...args),
}) {
  let disposed = false;
  let worker = null;
  let visualAnalysis = null;
  let deviceCheckPending = false;
  let inputDeviceId = null;
  let processorErrorListener = null;
  let deviceChangeListener = null;
  let premix = null;

  const graph = {
    epoch, sessionEpoch, stream, context,
    source: null, capture: null, silent: null,
    captureClockOriginContextTime: null,
    get premixed() { return premix !== null; },
    get visualAnalysis() { return visualAnalysis; },
    dispose, submitVisualAnalysis, returnBuffer, checkInputDeviceChange,
  };
  const admitted = () => !disposed && isCurrent(graph);

  function stopWorker() {
    const closing = worker;
    worker = null;
    if (!closing) return;
    try { closing.onmessage = null; closing.onerror = null; } catch {}
    try { closing.terminate(); } catch {}
  }

  function dispose() {
    if (disposed) return;
    // Revoke queued callbacks before releasing anything that can emit an event.
    disposed = true;
    deviceCheckPending = false;
    try { if (graph.capture) graph.capture.port.onmessage = null; } catch {}
    try {
      if (deviceChangeListener) mediaDevices?.removeEventListener?.('devicechange', deviceChangeListener);
    } catch {}
    deviceChangeListener = null;
    try {
      if (processorErrorListener) graph.capture?.removeEventListener?.('processorerror', processorErrorListener);
    } catch {}
    processorErrorListener = null;
    stopWorker();
    try { premix?.disconnect(); } catch {}
    for (const node of [graph.source, graph.capture, graph.silent]) {
      try { node?.disconnect(); } catch {}
    }
  }

  function attachVisualAnalysisWorker() {
    if (typeof WorkerClass !== 'function') return;
    try {
      const candidate = new WorkerClass('/mic-visual-analysis-worker.js', { name: 'relay-mic-visual-analysis' });
      worker = candidate;
      candidate.onmessage = (event) => {
        if (worker !== candidate || !admitted() || event.data?.type !== 'analysis') return;
        const analysis = parseMicVisualAnalysis(event.data);
        if (analysis) visualAnalysis = analysis;
      };
      candidate.onerror = () => { if (worker === candidate) stopWorker(); };
      candidate.postMessage({ type: 'configure', sampleRate: context.sampleRate });
    } catch {
      // Visualization is optional, but an inaccessible worker must not survive
      // a synchronous configure failure while capture continues without it.
      stopWorker();
    }
  }

  function submitVisualAnalysis(pcm) {
    if (!admitted() || !worker) return;
    try {
      // Transport keeps the original PCM; only the bounded analysis copy moves.
      const copy = pcm.slice(0);
      worker.postMessage({ type: 'pcm', buffer: copy }, [copy]);
    } catch { stopWorker(); }
  }

  function returnBuffer(buffer) {
    if (disposed) return;
    try { graph.capture.port.postMessage({ type: 'pcm-buffer-return', buffer }, [buffer]); } catch {}
  }

  function checkInputDeviceChange() {
    if (!admitted()) return false;
    const track = stream.getAudioTracks?.()[0] ?? null;
    const currentId = trackDeviceId(track);
    if (currentId === null) return false;
    // First revealed identity is not evidence of a route replacement.
    if (inputDeviceId === null) { inputDeviceId = currentId; return false; }
    if (currentId === inputDeviceId) return false;
    onInputDeviceChanged(graph);
    return true;
  }

  function checkDevicePresence() {
    if (!admitted() || deviceCheckPending) return;
    const track = stream.getAudioTracks?.()[0] ?? null;
    if (!track || track.readyState === 'ended') return;
    if (checkInputDeviceChange()) return;
    const deviceId = trackDeviceId(track);
    if (deviceId === null) return;
    deviceCheckPending = true;
    let enumeration;
    try { enumeration = mediaDevices.enumerateDevices(); }
    catch (error) {
      deviceCheckPending = false;
      warn('Microphone device presence check failed', error);
      return;
    }
    Promise.resolve(enumeration).then((devices) => {
      if (!admitted() || track.readyState === 'ended') return;
      // WebKit may update the live track's route only after enumeration settles.
      if (checkInputDeviceChange()) return;
      if (trackDeviceId(track) !== deviceId) return;
      const inputs = Array.isArray(devices) ? devices.filter(device => device?.kind === 'audioinput') : [];
      // Empty/filtered lists are ambiguous, never positive removal evidence.
      if (inputs.length === 0 || inputs.some(device => device.deviceId === deviceId)) return;
      return onInputDeviceRemoved(graph);
    }).catch(error => warn('Microphone device presence check failed', error))
      .finally(() => { deviceCheckPending = false; });
  }

  try {
    // Assign each resource before the next fallible operation, so partial
    // installation has exactly the same cleanup owner as an active graph.
    graph.source = context.createMediaStreamSource(stream);
    graph.capture = new AudioWorkletNodeClass(context, 'capture-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    graph.silent = context.createGain();
    graph.silent.gain.value = 0;
    inputDeviceId = trackDeviceId(stream.getAudioTracks?.()[0] ?? null);
    // Cached raw-PCM worklets still need the original dispatch-time anchor.
    graph.captureClockOriginContextTime = context.currentTime;
    if (typeof graph.capture.addEventListener === 'function') {
      processorErrorListener = () => { if (admitted()) onProcessorError(graph); };
      graph.capture.addEventListener('processorerror', processorErrorListener);
    }
    if (typeof mediaDevices?.enumerateDevices === 'function' && typeof mediaDevices?.addEventListener === 'function') {
      deviceChangeListener = checkDevicePresence;
      mediaDevices.addEventListener('devicechange', deviceChangeListener);
    }
    graph.capture.port.onmessage = event => { if (admitted()) onCaptureMessage(event, graph); };
    attachVisualAnalysisWorker();
    // New worklets stay raw-compatible until a current page opts in.
    graph.capture.port.postMessage({ type: 'capture-protocol', pcmEnvelope: true });
    premix = connectInput?.({ context, stream, source: graph.source, capture: graph.capture }) ?? null;
    if (!premix) graph.source.connect(graph.capture);
    graph.capture.connect(graph.silent).connect(context.destination);
    return graph;
  } catch (error) {
    dispose();
    throw error;
  }
}
