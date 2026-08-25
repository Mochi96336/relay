import {
  createListenerDebugFaultState,
  createListenerFlightRecorder,
} from './listener-diagnostics.js';

const debugEnabled = new URLSearchParams(location.search).get('audioDebug') === '1';

if (debugEnabled) {
  const recorder = createListenerFlightRecorder();
  const faults = createListenerDebugFaultState();
  const NativeWebSocket = window.WebSocket;
  const NativeAudioContext = window.AudioContext;
  const NativeWebkitAudioContext = window.webkitAudioContext;
  const NativeAudioWorkletNode = window.AudioWorkletNode;

  let listenerContext = null;
  let listenerGain = null;
  let monitorSocket = null;
  let monitorConnectionCount = 0;
  let monitorFrameCount = 0;
  let lastMonitorFrameAt = null;
  let lastWorkletHealth = null;
  let lastWorkletHealthAt = null;
  let blockResumeUntilMs = 0;
  let snapshotTimer = null;

  function now() {
    return performance.now();
  }

  function ageMs(timestamp) {
    return timestamp === null ? null : Math.max(0, now() - timestamp);
  }

  function socketState(socket) {
    if (!socket) return 'none';
    if (socket.readyState === NativeWebSocket.CONNECTING) return 'connecting';
    if (socket.readyState === NativeWebSocket.OPEN) return 'open';
    if (socket.readyState === NativeWebSocket.CLOSING) return 'closing';
    return 'closed';
  }

  function recordSnapshot() {
    const listenState = window.relayListenState ?? {};
    recorder.recordSnapshot({
      visibilityState: document.visibilityState,
      hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
      contextState: listenerContext?.state ?? 'closed',
      contextTime: listenerContext?.currentTime ?? null,
      audioReady: listenState.audioReady === true,
      effectiveMuted: listenState.muted === true,
      userMuted: listenState.userMuted === true,
      forcedReason: listenState.forcedReason ?? null,
      listenPhase: listenState.phase ?? null,
      transportEnabled: listenState.transportEnabled === true,
      monitorSocketState: socketState(monitorSocket),
      monitorConnectionCount,
      monitorFrameCount,
      lastMonitorFrameAgeMs: ageMs(lastMonitorFrameAt),
      lastWorkletHealthAgeMs: ageMs(lastWorkletHealthAt),
      workletHealth: lastWorkletHealth,
      blockResumeRemainingMs: Math.max(0, blockResumeUntilMs - now()),
      faults: faults.snapshot(),
    });
  }

  function markListenerContext(context) {
    if (!context || listenerContext === context) return;
    listenerContext = context;
    recorder.recordEvent('listener-context-selected', {
      state: context.state,
      sampleRate: context.sampleRate,
    });
    context.addEventListener('statechange', () => {
      recorder.recordEvent('audio-context-statechange', { state: context.state });
      recordSnapshot();
    });
  }

  function instrumentAudioContext(context) {
    const nativeSuspend = context.suspend?.bind(context);
    if (nativeSuspend) {
      try {
        context.suspend = (...args) => {
          const listener = listenerContext === context;
          recorder.recordEvent('audio-context-suspend-request', {
            listener,
            state: context.state,
          });
          let pending;
          try {
            pending = nativeSuspend(...args);
          } catch (error) {
            recorder.recordEvent('audio-context-suspend-failed', {
              listener,
              state: context.state,
              message: String(error),
            });
            throw error;
          }
          Promise.resolve(pending).then(() => {
            recorder.recordEvent('audio-context-suspend-settled', {
              listener: listenerContext === context,
              state: context.state,
            });
            recordSnapshot();
          }, (error) => {
            recorder.recordEvent('audio-context-suspend-failed', {
              listener: listenerContext === context,
              state: context.state,
              message: String(error),
            });
          });
          return pending;
        };
      } catch {}
    }

    const nativeResume = context.resume?.bind(context);
    if (nativeResume) {
      try {
        context.resume = (...args) => {
          const listener = listenerContext === context;
          const blocked = listener && now() < blockResumeUntilMs;
          recorder.recordEvent('audio-context-resume-request', {
            listener,
            blocked,
            state: context.state,
          });
          if (blocked) return Promise.resolve();
          return nativeResume(...args);
        };
      } catch {}
    }

    const nativeCreateGain = context.createGain?.bind(context);
    if (nativeCreateGain) {
      try {
        context.createGain = (...args) => {
          const gain = nativeCreateGain(...args);
          if (listenerContext === context) listenerGain = gain;
          return gain;
        };
      } catch {}
    }
  }

  function wrapAudioContext(Constructor) {
    if (typeof Constructor !== 'function') return Constructor;
    return new Proxy(Constructor, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget);
        instrumentAudioContext(context);
        recorder.recordEvent('audio-context-created', {
          state: context.state,
          sampleRate: context.sampleRate,
        });
        return context;
      },
    });
  }

  if (typeof NativeAudioContext === 'function') {
    window.AudioContext = wrapAudioContext(NativeAudioContext);
  }
  if (
    typeof NativeWebkitAudioContext === 'function'
    && NativeWebkitAudioContext !== NativeAudioContext
  ) {
    window.webkitAudioContext = wrapAudioContext(NativeWebkitAudioContext);
  } else if (typeof NativeAudioContext === 'function' && 'webkitAudioContext' in window) {
    window.webkitAudioContext = window.AudioContext;
  }

  if (typeof NativeAudioWorkletNode === 'function') {
    window.AudioWorkletNode = new Proxy(NativeAudioWorkletNode, {
      construct(target, args, newTarget) {
        const node = Reflect.construct(target, args, newTarget);
        const [context, name] = args;
        if (name === 'playback-processor') {
          markListenerContext(context);
          recorder.recordEvent('playback-worklet-created');
        }
        return node;
      },
    });
  }

  function instrumentSocket(socket) {
    socket.__relayDebugRole = 'unknown';
    const nativeSend = socket.send.bind(socket);
    socket.send = (data) => {
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data);
          if (message.type === 'register' && message.role === 'monitor') {
            socket.__relayDebugRole = 'monitor';
            monitorSocket = socket;
            monitorConnectionCount += 1;
            recorder.recordEvent('monitor-register', { connection: monitorConnectionCount });
          }
        } catch {}
      }
      return nativeSend(data);
    };

    socket.addEventListener('open', () => {
      if (socket.__relayDebugRole === 'monitor') recorder.recordEvent('monitor-open');
    });
    socket.addEventListener('close', (event) => {
      if (socket.__relayDebugRole !== 'monitor') return;
      recorder.recordEvent('monitor-close', { code: event.code, reason: event.reason });
      if (monitorSocket === socket) monitorSocket = null;
      recordSnapshot();
    });
    socket.addEventListener('error', () => {
      if (socket.__relayDebugRole === 'monitor') recorder.recordEvent('monitor-error');
    });
    // This listener is registered before listen.js installs its monitor message
    // handler. In debug mode only, stopImmediatePropagation lets the harness
    // create a real local starvation while keeping the transport socket open.
    socket.addEventListener('message', (event) => {
      if (socket.__relayDebugRole !== 'monitor' || !(event.data instanceof ArrayBuffer)) return;
      monitorFrameCount += 1;
      lastMonitorFrameAt = now();
      if (!faults.shouldDropPcm()) return;
      recorder.recordEvent('fault-pcm-dropped', { byteLength: event.data.byteLength });
      event.stopImmediatePropagation();
    });
  }

  if (typeof NativeWebSocket === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        instrumentSocket(socket);
        return socket;
      },
    });
  }

  window.addEventListener('relay-listen-health', (event) => {
    lastWorkletHealth = event.detail ? { ...event.detail } : null;
    lastWorkletHealthAt = now();
  });
  window.addEventListener('relay-listen-state', (event) => {
    recorder.recordEvent('listen-state', {
      state: event.detail?.state ?? null,
      phase: event.detail?.phase ?? null,
      muted: event.detail?.muted === true,
      audioReady: event.detail?.audioReady === true,
      transportEnabled: event.detail?.transportEnabled === true,
    });
  });
  document.addEventListener('visibilitychange', () => {
    recorder.recordEvent('visibilitychange', { state: document.visibilityState });
    recordSnapshot();
  });
  window.addEventListener('pageshow', (event) => {
    recorder.recordEvent('pageshow', { persisted: event.persisted === true });
    recordSnapshot();
  });
  window.addEventListener('pagehide', (event) => {
    recorder.recordEvent('pagehide', { persisted: event.persisted === true });
    recordSnapshot();
  });

  function scheduleSnapshotLoop() {
    if (snapshotTimer !== null) clearInterval(snapshotTimer);
    snapshotTimer = setInterval(recordSnapshot, 500);
  }

  function disconnectMonitor() {
    recorder.recordEvent('fault-monitor-disconnect');
    monitorSocket?.close(4000, 'listener debug fault');
  }

  function dropPcm(ms = 3_000) {
    const untilMs = faults.dropPcmFor(ms);
    recorder.recordEvent('fault-pcm-drop-start', { ms, untilMs });
    return untilMs;
  }

  async function interruptAudio(ms = 2_000) {
    if (!listenerContext) throw new Error('Listener AudioContext is not ready.');
    const durationMs = Math.max(1, Number(ms) || 2_000);
    blockResumeUntilMs = Math.max(blockResumeUntilMs, now() + durationMs);
    recorder.recordEvent('fault-audio-interrupt-start', { durationMs, untilMs: blockResumeUntilMs });
    try {
      await listenerContext.suspend();
    } catch (error) {
      recorder.recordEvent('fault-audio-interrupt-suspend-failed', { message: String(error) });
      throw error;
    }
    setTimeout(() => {
      if (!listenerContext || now() < blockResumeUntilMs) return;
      recorder.recordEvent('fault-audio-interrupt-release', { state: listenerContext.state });
      try {
        const pending = listenerContext.resume();
        pending?.catch?.(() => {});
      } catch {}
    }, durationMs + 1);
  }

  function silenceOutput(ms = 3_000) {
    if (!listenerGain || !listenerContext) throw new Error('Listener output gain is not ready.');
    const durationMs = Math.max(1, Number(ms) || 3_000);
    const untilMs = faults.silenceOutputFor(durationMs);
    recorder.recordEvent('fault-output-silence-start', { durationMs, untilMs });
    try {
      listenerGain.gain.cancelScheduledValues(listenerContext.currentTime);
      listenerGain.gain.setValueAtTime(0, listenerContext.currentTime);
    } catch {
      listenerGain.gain.value = 0;
    }
    setTimeout(() => {
      if (faults.shouldSilenceOutput()) return;
      recorder.recordEvent('fault-output-silence-release');
      document.querySelector('#listen-gain')?.dispatchEvent(new Event('input', { bubbles: true }));
    }, durationMs + 1);
  }

  function clearFaults() {
    faults.clear();
    blockResumeUntilMs = 0;
    recorder.recordEvent('faults-cleared');
    document.querySelector('#listen-gain')?.dispatchEvent(new Event('input', { bubbles: true }));
  }

  window.__relayListenerDiagnostics = {
    dump: () => recorder.dump(),
    clear: () => recorder.clear(),
    snapshot: () => {
      recordSnapshot();
      const dump = recorder.dump();
      return dump.snapshots.at(-1) ?? null;
    },
    faults: {
      disconnectMonitor,
      dropPcm,
      interruptAudio,
      silenceOutput,
      clear: clearFaults,
      state: () => faults.snapshot(),
    },
  };

  recorder.recordEvent('listener-debug-enabled');
  scheduleSnapshotLoop();
  recordSnapshot();
}
