export type RelayAudioSessionType = 'auto' | 'playback' | 'play-and-record';

export function resolveAudioSessionType(options?: {
  playback?: boolean;
  microphone?: boolean;
}): RelayAudioSessionType;

export class AudioSessionPolicy {
  constructor(navigatorProvider?: () => { audioSession?: { type: string } } | null | undefined);
  playbackClaim: boolean;
  microphoneClaim: boolean;
  claimPlayback(active: boolean): RelayAudioSessionType;
  claimMicrophone(active: boolean): RelayAudioSessionType;
  type(): RelayAudioSessionType;
  apply(): RelayAudioSessionType;
}

export function claimPlaybackAudio(active: boolean): RelayAudioSessionType;
export function claimMicrophoneAudio(active: boolean): RelayAudioSessionType;
