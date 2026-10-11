export type MicVisualAnalysis = {
  spectrumBands: number[];
  f0Hz: number | null;
  pitchConfidence: number;
};
export function parseMicVisualAnalysis(payload: unknown): MicVisualAnalysis | null;

/** Resources belong to one graph; disposing never stops its track or context. */
export type MicCaptureGraph = {
  readonly epoch: number;
  readonly sessionEpoch: number;
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly capture: AudioWorkletNode;
  readonly silent: GainNode;
  readonly captureClockOriginContextTime: number;
  readonly visualAnalysis: MicVisualAnalysis | null;
  dispose(): void;
  submitVisualAnalysis(pcm: ArrayBuffer): void;
  returnBuffer(buffer: ArrayBuffer): void;
  checkInputDeviceChange(): boolean;
};
export function createMicCaptureGraph(options: {
  epoch: number;
  sessionEpoch: number;
  stream: MediaStream;
  context: AudioContext;
  isCurrent: (graph: MicCaptureGraph) => boolean;
  onCaptureMessage: (event: MessageEvent, graph: MicCaptureGraph) => void;
  onProcessorError: (graph: MicCaptureGraph) => void;
  onInputDeviceChanged: (graph: MicCaptureGraph) => void;
  onInputDeviceRemoved: (graph: MicCaptureGraph) => void | Promise<unknown>;
  mediaDevices?: Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>;
  AudioWorkletNodeClass?: typeof AudioWorkletNode;
  WorkerClass?: typeof Worker;
  warn?: (...args: unknown[]) => void;
}): MicCaptureGraph;
