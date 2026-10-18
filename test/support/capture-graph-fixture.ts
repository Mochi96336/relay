import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './source-contract.js';
const { classifyCaptureDispatch } = await import(new URL('../../public/capture-dispatch.js', import.meta.url).href);
const { splitPcmForPacketLimit } = await import(new URL('../../public/audio-packetizer.js', import.meta.url).href);
const { createMicCaptureGraph, parseMicVisualAnalysis } = await import(new URL('../../public/mic-capture-graph.js', import.meta.url).href);

export function captureFixture(failure: string | null = null) {
  const effects: string[] = [];
  const nodes: any[] = [], workers: any[] = [];
  const messages: any[] = [];
  const events = new Map<string, Set<(...args: any[]) => void>>();
  const track = { readyState: 'live', deviceId: 'mic-a', stops: 0,
    getSettings() { return { deviceId: this.deviceId }; }, stop() { this.stops++; } };
  const stream = { getAudioTracks: () => [track] };
  const check = (at: string) => { if (failure === at) throw new Error(at); };
  const mediaDevices = {
    enumerations: 0,
    enumerate: () => Promise.resolve([{ kind: 'audioinput', deviceId: 'mic-a' }]),
    enumerateDevices() { this.enumerations++; return this.enumerate(); },
    addEventListener(type: string, listener: (...args: any[]) => void) {
      const set = events.get(type) ?? new Set(); set.add(listener); events.set(type, set);
    },
    removeEventListener(type: string, listener: (...args: any[]) => void) { events.get(type)?.delete(listener); },
    emit() { for (const listener of [...events.get('devicechange') ?? []]) listener(); },
  };
  function node(kind: string) {
    check(kind);
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const n = { kind, disconnects: 0, connected: false, listeners,
      gain: { value: 1 },
      port: { onmessage: null as any, posted: [] as any[],
        postMessage(message: any, transfer: Transferable[] = []) {
          check('protocol'); this.posted.push(structuredClone(message, { transfer }));
        } },
      connect(target: unknown) { env.beforeConnect?.(); check(`connect-${kind}`); this.connected = true; return target; },
      disconnect() { this.disconnects++; this.connected = false; },
      addEventListener(type: string, listener: (...args: any[]) => void) {
        const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);
      },
      removeEventListener(type: string, listener: (...args: any[]) => void) { listeners.get(type)?.delete(listener); },
      emit(type: string) { for (const listener of [...listeners.get(type) ?? []]) listener(); },
    };
    nodes.push(n);
    return n;
  }
  const context = { sampleRate: 48000, currentTime: 3, closes: 0, destination: {},
    createMediaStreamSource: () => node('source'), createGain: () => node('gain'),
    close() { this.closes++; } };
  const env: any = {
    captureGraphEpoch: 0, activeCaptureGraph: null, activeNode: null,
    mediaStream: stream, audioContext: context, publisherSessionEpoch: 1,
    localFileMix: { connectInput: null as any },
    navigator: { mediaDevices },
    AudioWorkletNode: class { constructor() { return node('worklet'); } },
    Worker: class {
      terminations = 0;
      onmessage: any = null; onerror: any = null;
      posted: any[] = [];
      constructor(readonly url: string, readonly options: { name: string }) { check('worker-create'); workers.push(this); }
      postMessage(message: any, transfer: Transferable[] = []) {
        check(`worker-${message.type}`); this.posted.push(structuredClone(message, { transfer }));
      }
      terminate() { this.terminations++; }
    },
    isCurrentPublisherSession: (epoch: number) => env.publisherSessionEpoch === epoch,
    micCaptureRecovery: { noteProcessorError: () => env.processorDecision },
    processorDecision: { rebuild: true, exhausted: false },
    captureSnapshot: () => ({}),
    rebuildPublisherCaptureGraph: async (reason: string) => { effects.push(reason); },
    finishMicrophoneSession: async (reason: string, options: any) => {
      effects.push(`${reason}:${options.releaseMic}`);
    },
    handleCaptureWorkletMessage: (event: any, graph: any) => {
      if (vm.runInContext('captureGraphIsCurrent(activeCaptureGraph)', scope) && env.activeCaptureGraph === graph) messages.push(event.data);
    },
    console: { warn() {}, error() {} },
  };
  const source = parseTypeScriptSource(new URL('../../public/app.js', import.meta.url),
    readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'));
  env.createMicCaptureGraph = (options: any) => createMicCaptureGraph({
    ...options, mediaDevices, AudioWorkletNodeClass: env.AudioWorkletNode,
    WorkerClass: env.Worker, warn: env.console.warn,
  });
  env.parseMicVisualAnalysis = parseMicVisualAnalysis;
  const scope = vm.createContext(env);
  for (const name of ['disposeCaptureGraph', 'captureGraphIsCurrent',
    'rebuildCaptureForInputDeviceChange', 'handleCaptureProcessorError',
    'submitMicVisualAnalysis', 'returnCaptureBuffer', 'installCaptureGraph']) {
    vm.runInContext(functionCode(source, name), scope);
  }
  return {
    env, nodes, workers, mediaDevices, context, stream, track, effects, events, messages,
    setFailure(value: string | null) { failure = value; },
    usePcmHandler(overrides: Record<string, unknown> = {}) {
      Object.assign(env, {
        ArrayBuffer, performance: { now: () => 100 },
        captureSampleCursor: 0, capturePacketSequence: 0, captureGeneration: 7,
        captureInputMuted: false, sampleSongCapture: null, micOpus: null,
        classifyCaptureDispatch, splitPcmForPacketLimit,
        noteCaptureDispatch() {}, recordUplinkDrop() {},
        audioTransport: { maxPacketBytes: () => Infinity, send: () => ({ sent: true }) },
        ...overrides,
      });
      env.micCaptureRecovery.observe = () => ({ recovered: false });
      for (const name of ['AUDIO_PACKET_MAGIC', 'AUDIO_PACKET_VERSION', 'AUDIO_PACKET_HEADER_BYTES', 'AUDIO_PACKET_SOURCE_MIC']) {
        vm.runInContext(`const ${name} = ${variableInitializerCode(source, name)}`, scope);
      }
      vm.runInContext(functionCode(source, 'framePcm'), scope);
      vm.runInContext(functionCode(source, 'handleCaptureWorkletMessage'), scope);
    },
    install() { return vm.runInContext('installCaptureGraph(1, mediaStream, audioContext)', scope); },
    dispose(graph = env.activeCaptureGraph) { env.target = graph; vm.runInContext('disposeCaptureGraph(target)', scope); },
    analyze(graph: any, pcm: ArrayBuffer) { env.target = graph; env.pcm = pcm; vm.runInContext('submitMicVisualAnalysis(target, pcm)', scope); },
    returnBuffer(graph: any, pcm: ArrayBuffer) { env.target = graph; env.pcm = pcm; vm.runInContext('returnCaptureBuffer(target, pcm)', scope); },
    flush: async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); },
  };
}
