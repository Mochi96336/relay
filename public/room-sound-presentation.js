function operationalNoteKey(phase) {
  if (phase === 'interrupted') return 'roomSound.recovering';
  if (phase === 'reconnecting') return 'roomSound.reconnecting';
  if (phase === 'connecting') return 'roomSound.connecting';
  if (phase === 'buffering') return 'roomSound.buffering';
  if (phase === 'retry' || phase === 'start-failed') return 'roomSound.retry';
  if (phase === 'mic-failed-resume') return 'roomSound.micFailedResume';
  if (phase === 'first-interaction') return 'roomSound.enableHint';
  return null;
}

function compactStatusKey(state, phase) {
  if (phase === 'retry' || phase === 'start-failed') return 'roomSound.compact.retry';
  if (state === 'mic-muted') return 'roomSound.compact.singing';
  if (state === 'playback-muted') return 'roomSound.compact.backing';
  if (state === 'review-muted') return 'roomSound.compact.recording';
  if (phase === 'interrupted') return 'roomSound.compact.recovering';
  if (phase === 'reconnecting') return 'roomSound.compact.reconnecting';
  if (phase === 'connecting') return 'roomSound.compact.connecting';
  if (phase === 'buffering') return 'roomSound.compact.buffering';
  if (phase === 'first-interaction') return 'roomSound.compact.enable';
  if (state === 'muted' || state === 'off') return 'roomSound.compact.muted';
  return null;
}

export function roomSoundControlPresentation(detail = {}) {
  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');
  const forced = Boolean(detail.forcedReason);
  const muted = detail.muted === true;

  return {
    labelKey: 'roomSound.label',
    scopeKey: 'roomSound.scope',
    volumeLabelKey: 'roomSound.volume',
    volumeAriaLabelKey: 'roomSound.volumeAria',
    toggleAriaLabelKey: muted || forced ? 'roomSound.turnOnAria' : 'roomSound.muteAria',
    compactKey: compactStatusKey(state, phase),
  };
}

export function roomSoundStableNote(detail = {}) {
  const state = String(detail.state ?? 'ready');
  if (state === 'mic-muted') return 'roomSound.pausedForMic';
  if (state === 'playback-muted') return 'roomSound.pausedForBacking';
  if (state === 'review-muted') return 'roomSound.pausedForRecording';
  if (state === 'muted') return 'roomSound.muted';
  if (state === 'ready') return 'roomSound.enableHint';
  return null;
}

export function roomSoundActionNote(detail = {}) {
  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');

  if (state === 'mic-muted') {
    if (phase === 'mic-starting') return 'roomSound.micStarting';
    if (phase === 'handoff-starting') return 'roomSound.micTakeover';
    return null;
  }
  if (state === 'playback-muted' || state === 'review-muted' || phase === 'first-interaction') return null;
  return operationalNoteKey(phase);
}

export function roomSoundPresentation(detail = {}) {
  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');

  if (state === 'mic-muted') {
    return { toggleKey: 'roomSound.paused', noteKey: 'roomSound.pausedForMic' };
  }
  if (state === 'playback-muted') {
    return { toggleKey: 'roomSound.paused', noteKey: 'roomSound.pausedForBacking' };
  }
  if (state === 'review-muted') {
    return { toggleKey: 'roomSound.paused', noteKey: 'roomSound.pausedForRecording' };
  }
  if (state === 'muted') {
    return {
      toggleKey: 'roomSound.turnOn',
      noteKey: operationalNoteKey(phase) ?? 'roomSound.muted',
    };
  }
  return {
    toggleKey: 'roomSound.mute',
    noteKey: operationalNoteKey(phase) ?? (state === 'ready' ? 'roomSound.enableHint' : null),
  };
}
