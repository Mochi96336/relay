function copy(english, traditionalChinese, isChinese) {
  return isChinese ? traditionalChinese : english;
}

function operationalNote(phase, isChinese) {
  if (phase === 'reconnecting') {
    return copy('Reconnecting room sound…', '房間聲音重新連線中…', isChinese);
  }
  if (phase === 'connecting') {
    return copy('Connecting room sound…', '正在連接房間聲音…', isChinese);
  }
  if (phase === 'buffering') {
    return copy('Buffering room sound…', '房間聲音緩衝中…', isChinese);
  }
  if (phase === 'retry') {
    return copy('Room sound did not start. Tap again to retry.', '房間聲音未啟動，再點一下重試', isChinese);
  }
  if (phase === 'start-failed') {
    return copy('Could not start room sound. Tap again to retry.', '無法啟動房間聲音，再點一下重試', isChinese);
  }
  if (phase === 'mic-failed-resume') {
    return copy('Mic did not start. Room sound is available again.', 'Mic 未啟動，房間聲音已恢復', isChinese);
  }
  if (phase === 'first-interaction') {
    return copy('Tap once to enable room sound.', '點一下以啟用房間聲音', isChinese);
  }
  return '';
}

export function roomSoundStableNote(detail = {}, isChinese = false) {
  const state = String(detail.state ?? 'ready');

  if (state === 'mic-muted') {
    return copy('Paused while you sing.', '唱歌時暫停', isChinese);
  }
  if (state === 'playback-muted') {
    return copy('This device is playing the backing track.', '這支裝置正在播放伴奏', isChinese);
  }
  if (state === 'review-muted') {
    return copy('Take playback is playing.', '正在播放錄音', isChinese);
  }
  if (state === 'muted') {
    return copy('Room sound is muted.', '房間聲音已靜音', isChinese);
  }
  if (state === 'ready') {
    return copy('Tap once to enable room sound.', '點一下以啟用房間聲音', isChinese);
  }
  return '';
}

export function roomSoundActionNote(detail = {}, isChinese = false) {
  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');

  if (state === 'mic-muted') {
    if (phase === 'mic-starting') {
      return copy('Starting Mic…', 'Mic 啟動中…', isChinese);
    }
    if (phase === 'handoff-starting') {
      return copy('Taking over Mic…', '正在接手 Mic…', isChinese);
    }
    return '';
  }

  if (state === 'playback-muted' || state === 'review-muted') return '';
  if (phase === 'first-interaction') return '';
  return operationalNote(phase, isChinese);
}

export function roomSoundPresentation(detail = {}, isChinese = false) {
  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');

  if (state === 'mic-muted') {
    return {
      toggle: copy('Paused', '暫停中', isChinese),
      note: copy('Paused while you sing.', '唱歌時暫停', isChinese),
    };
  }

  if (state === 'playback-muted') {
    return {
      toggle: copy('Paused', '暫停中', isChinese),
      note: copy('This device is playing the backing track.', '這支裝置正在播放伴奏', isChinese),
    };
  }

  if (state === 'review-muted') {
    return {
      toggle: copy('Paused', '暫停中', isChinese),
      note: copy('Take playback is playing.', '正在播放錄音', isChinese),
    };
  }

  if (state === 'muted') {
    return {
      toggle: copy('Turn on', '開啟', isChinese),
      note: operationalNote(phase, isChinese)
        || copy('Room sound is muted.', '房間聲音已靜音', isChinese),
    };
  }

  const note = operationalNote(phase, isChinese)
    || (state === 'ready'
      ? copy('Tap once to enable room sound.', '點一下以啟用房間聲音', isChinese)
      : '');

  return {
    toggle: copy('Mute', '靜音', isChinese),
    note,
  };
}
