const base = window.relayI18n;

if (base) {
  const messages = {
    en: {
      'people.inRoom': 'In the room',
      'people.status.online': 'Online',
      'people.status.reconnecting': 'Reconnecting',
      'people.status.micReconnecting': 'Mic reconnecting',
      'people.status.singing': 'Singing',
      'recording.record': 'Record',
      'recording.stop': 'Stop recording',
      'recording.starting': 'Starting recording…',
      'recording.ready': '✓ Recording ready',
      'recording.finishing': 'Finishing recording…',
      'recording.failed': 'Recording didn’t finish',
      'recording.blocked.reconnecting': 'Reconnecting…',
      'recording.blocked.mix-not-active': 'Sound is getting ready…',
      'recording.blocked.timing-calibration-active': 'Timing is aligning…',
      'recording.blocked.take-not-ready': 'Recording isn’t ready yet',
      'recording.blocked.take-active': 'Recording is already in progress',
      'recording.blocked.unavailable': 'Recording is unavailable right now',
      'recording.error.storage-unavailable': 'Recording storage is unavailable',
      'recording.error.generic': 'Recording didn’t finish',
      'roomSound.label': 'Room sound',
      'roomSound.scope': 'This device only',
      'roomSound.volume': 'Volume',
      'roomSound.volumeAria': 'Room sound volume',
      'roomSound.turnOnAria': 'Turn on room sound',
      'roomSound.muteAria': 'Mute room sound',
      'roomSound.turnOn': 'Turn on',
      'roomSound.mute': 'Mute',
      'roomSound.paused': 'Paused',
      'roomSound.muted': 'Room sound is muted',
      'roomSound.enableHint': 'Tap once to enable room sound',
      'roomSound.pausedForMic': 'Paused while you sing',
      'roomSound.pausedForBacking': 'This device is playing the backing track',
      'roomSound.pausedForRecording': 'Recording playback is playing',
      'roomSound.recovering': 'Recovering room sound…',
      'roomSound.reconnecting': 'Reconnecting room sound…',
      'roomSound.connecting': 'Connecting room sound…',
      'roomSound.buffering': 'Buffering room sound…',
      'roomSound.retry': 'Room sound did not start. Tap again to retry',
      'roomSound.micFailedResume': 'Mic did not start. Room sound is available again',
      'roomSound.micStarting': 'Starting Mic…',
      'roomSound.micTakeover': 'Taking over Mic…',
    },
    'zh-Hant': {
      'people.inRoom': '房間裡',
      'people.status.online': '在線',
      'people.status.reconnecting': '重新連線中',
      'people.status.micReconnecting': 'Mic 重新連線中',
      'people.status.singing': '正在唱',
      'recording.record': '錄音',
      'recording.stop': '停止錄音',
      'recording.starting': '開始錄音中…',
      'recording.ready': '✓ 錄好了',
      'recording.finishing': '正在完成錄音…',
      'recording.failed': '錄音未完成',
      'recording.blocked.reconnecting': '重新連線中…',
      'recording.blocked.mix-not-active': '聲音準備中…',
      'recording.blocked.timing-calibration-active': '時間對齊中…',
      'recording.blocked.take-not-ready': '目前無法錄音',
      'recording.blocked.take-active': '目前正在錄音',
      'recording.blocked.unavailable': '目前無法錄音',
      'recording.error.storage-unavailable': '目前無法使用錄音儲存空間',
      'recording.error.generic': '錄音未完成',
      'roomSound.label': '房間聲音',
      'roomSound.scope': '只影響這支裝置',
      'roomSound.volume': '音量',
      'roomSound.volumeAria': '房間聲音音量',
      'roomSound.turnOnAria': '開啟房間聲音',
      'roomSound.muteAria': '靜音房間聲音',
      'roomSound.turnOn': '開啟',
      'roomSound.mute': '靜音',
      'roomSound.paused': '暫停中',
      'roomSound.muted': '房間聲音已靜音',
      'roomSound.enableHint': '點一下以啟用房間聲音',
      'roomSound.pausedForMic': '唱歌時暫停',
      'roomSound.pausedForBacking': '這支裝置正在播放伴奏',
      'roomSound.pausedForRecording': '正在播放錄音',
      'roomSound.recovering': '正在恢復房間聲音…',
      'roomSound.reconnecting': '房間聲音重新連線中…',
      'roomSound.connecting': '正在連接房間聲音…',
      'roomSound.buffering': '房間聲音緩衝中…',
      'roomSound.retry': '房間聲音未啟動，再點一下重試',
      'roomSound.micFailedResume': 'Mic 未啟動，房間聲音已恢復',
      'roomSound.micStarting': 'Mic 啟動中…',
      'roomSound.micTakeover': '正在接手 Mic…',
    },
  };

  const baseT = typeof base.t === 'function' ? base.t.bind(base) : (key) => key;
  const baseHas = typeof base.has === 'function' ? base.has.bind(base) : () => false;

  function format(template, vars = {}) {
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
  }

  base.t = (key, vars = {}) => {
    const locale = base.getLocale?.() ?? 'en';
    const template = messages[locale]?.[key] ?? messages.en[key];
    return template === undefined ? baseT(key, vars) : format(template, vars);
  };
  base.has = (key) => Object.prototype.hasOwnProperty.call(messages.en, key) || baseHas(key);
}
