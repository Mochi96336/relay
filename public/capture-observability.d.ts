export type CaptureAppliedSettings = {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  audioSessionType: string | null;
};

export type CaptureLevelSnapshot = {
  peakDbfs: number;
  rmsDbfs: number;
};

export function readCaptureSettings(
  stream: { getAudioTracks?: () => Array<{ getSettings?: () => Record<string, unknown> }> } | null | undefined,
  navigatorLike?: { audioSession?: { type?: unknown } } | null,
): CaptureAppliedSettings | null;

export function captureLevelSnapshot(
  level: { peakDbfs?: unknown; rmsDbfs?: unknown } | null | undefined,
): CaptureLevelSnapshot | null;


export function enforceUnprocessedCapture(
  stream: {
    getAudioTracks?: () => Array<{
      getSettings?: () => Record<string, unknown>;
      getCapabilities?: () => Record<string, unknown>;
      getConstraints?: () => Record<string, unknown>;
      applyConstraints?: (constraints: Record<string, unknown>) => Promise<void>;
    }>;
  } | null | undefined,
): Promise<boolean>;

export function captureVoiceProcessingActive(
  settings: CaptureAppliedSettings | null | undefined,
): boolean;
