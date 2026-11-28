export function resolveAudioSessionType({ playback = false, microphone = false } = {}) {
  if (microphone) return 'play-and-record';
  if (playback) return 'playback';
  return 'auto';
}

export class AudioSessionPolicy {
  constructor(navigatorProvider = () => globalThis.navigator) {
    this.navigatorProvider = navigatorProvider;
    this.playbackClaim = false;
    this.microphoneOwners = new Set();
  }

  claimPlayback(active) {
    this.playbackClaim = Boolean(active);
    return this.apply();
  }

  get microphoneClaim() {
    return this.microphoneOwners.size > 0;
  }

  claimMicrophone(active, owner = 'primary') {
    if (active) this.microphoneOwners.add(owner);
    else this.microphoneOwners.delete(owner);
    return this.apply();
  }

  type() {
    return resolveAudioSessionType({
      playback: this.playbackClaim,
      microphone: this.microphoneClaim,
    });
  }

  apply() {
    const type = this.type();
    let navigatorLike = null;
    try {
      navigatorLike = this.navigatorProvider?.() ?? null;
    } catch {}

    const session = navigatorLike?.audioSession;
    if (!session) return type;

    try {
      if (session.type !== type) session.type = type;
    } catch (error) {
      console.warn('AudioSession policy failed', error);
    }
    return type;
  }
}

const pageAudioSessionPolicy = new AudioSessionPolicy();

export function claimPlaybackAudio(active) {
  return pageAudioSessionPolicy.claimPlayback(active);
}

export function claimMicrophoneAudio(active, owner) {
  return pageAudioSessionPolicy.claimMicrophone(active, owner);
}
