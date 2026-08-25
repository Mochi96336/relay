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
