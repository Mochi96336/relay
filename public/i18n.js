(() => {
  const STORAGE_KEY = 'relay.locale.v1';
  const DEFAULT_LOCALE = 'en';
  const SUPPORTED = new Set(['en', 'zh-Hant']);

  const messages = {
    en: {
      'people.connecting': 'Connecting…',
      'people.reconnecting': 'Reconnecting…',
      'people.online': '{count} online',
      'people.you': 'You',
      'people.renameTitle': 'Rename yourself',
      'people.nicknameLabel': 'Your Relay nickname',
      'people.reconnectingSuffix': 'reconnecting',
      'people.micReconnectingSuffix': 'mic reconnecting',
      'language.label': 'Language',
      'mic.label': 'Mic',
      'mic.take': 'Take Mic',
      'mic.release': 'Release Mic',
      'mic.cancel': 'Cancel',
      'mic.takeover': 'Take over Mic',
      'mic.takeoverPrompt': '{name} is using Mic.',
      'mic.takeoverPending': 'Taking over Mic…',
      'mic.startFailed': 'Could not start Mic.',
      'mic.takeoverChangedOwner': 'Mic moved to {name}. Confirm again to take over.',
      'mic.takeoverChanged': 'Mic changed. Try taking Mic again.',

      'song.label': 'Song',
      'song.change': 'Change song',
      'song.done': 'Done',
      'song.roomSong': 'Room song',
      'song.pastePlaceholder': 'Paste a YouTube link',
      'song.inputLabel': 'YouTube URL or video ID',
      'song.load': 'Load',
      'song.notLoaded': 'not loaded',
      'song.noteInitial': 'Paste a song, then use the YouTube player normally.',
      'song.role.holder': 'Playing from this phone',
      'song.role.preparing': 'Preparing on this phone',
      'song.role.observer': 'Playing from another phone',
      'song.role.empty': 'No song yet',
      'song.state.preparing': 'Getting ready',
      'song.state.ended': 'Ended',
      'song.state.playing': 'Playing',
      'song.state.paused': 'Paused',
      'song.state.buffering': 'Buffering',
      'song.state.ready': 'Ready',
      'song.buffered': '{percent}% buffered',
      'song.bufferUnknown': 'buffer --',
      'song.timelineJump': 'Timeline jump detected: {delta} s.',
      'song.bufferingIndependent': 'YouTube is buffering. Mic transport can keep running independently.',
      'song.timelineAuthorized': 'Timeline is media time from the YouTube player; shared controls are authorized by Relay.',
      'song.observerCannotChange': 'Room playback is on another phone. Take the mic on this phone before changing the song.',
      'song.requestingAction': 'Requesting room {action}…',
      'song.handoffPrepared': 'Room song is prepared on this device. Relay is waiting to switch playback safely.',
      'song.preparingHandoff': 'Preparing the room song for microphone handoff. Playback will not start until the server commits the switch.',
      'song.switchingHere': 'Switching room playback to this device…',
      'song.movedWithMic': 'Room playback moved with the microphone. This player is no longer driving the shared song.',
      'song.handoffCancelled': 'Room playback handoff was cancelled. Take the microphone again to retry.',
      'song.handoffComplete': 'Room playback handoff complete. This device now follows the shared song.',
      'song.handoffAutoplayRecovery': 'Playback moved here, but the browser paused audio. Tap Play once in the visible YouTube player.',
      'song.invalidVideo': 'invalid URL / video ID',
      'song.invalidVideoHelp': 'Paste a YouTube watch, youtu.be, Shorts, Live, Embed URL, or an 11-character video ID.',
      'song.initialHelp': 'Load a video, then use the visible YouTube controls. Shared song changes are authorized by Relay; joining the room never starts playback by itself.',

      'voice.label': 'Voice',
      'voice.connecting': 'Connecting…',
      'voice.gettingReady': 'Getting ready…',
      'voice.keepSpeakerAudible': 'Keep the speaker audible.',
      'voice.songPreparing': 'Getting the song ready…',
      'voice.playbackMovingHere': 'Playback is moving to this phone.',
      'voice.playbackChangingPhones': 'Playback is changing phones.',
      'voice.micFree': 'Mic is free',
      'voice.addSongToBegin': 'Take the mic, or add a song for backing.',
      'voice.startingYours': 'Starting your mic…',
      'voice.waitingFirstAudio': 'Waiting for the first audio frame from this phone.',
      'voice.interruptedYours': 'Mic audio interrupted',
      'voice.mediaConnectedAudioStopped': 'The media path is connected, but audio stopped arriving.',
      'voice.ready': 'Ready when you are',
      'voice.takeMicWhenReady': 'Take the mic when you want to sing.',
      'voice.reconnectingYours': 'Reconnecting your mic…',
      'voice.holdingPlace': 'Relay is holding your place for a moment.',
      'voice.live': 'You’re live',
      'voice.timingRecovering': 'Timing is recovering while you keep singing.',
      'voice.toRoom': 'Your voice is going to the room.',
      'voice.useSpeaker': 'Keep the sound playing aloud so Relay can hear the playback correctly.',
      'voice.startingOther': 'is starting the microphone…',
      'voice.interruptedOther': 'microphone audio interrupted',
      'voice.someone': 'Someone',
      'voice.reconnecting': 'microphone reconnecting…',
      'voice.singing': 'is singing',
      'voice.micUnavailable': 'Microphone unavailable',
      'voice.httpsRequired': 'Open Relay over HTTPS so this phone can use its microphone.',
      'voice.permissionRequired': 'Allow microphone access in your browser, then try again.',
      'voice.checkAccess': 'Check microphone access on this phone, then try again.',

      'take.aria': 'Take recording',
      'take.record': 'Record take',
      'take.stop': 'Stop',
      'take.finishing': 'Finishing take…',
      'take.last': 'Last take · {duration}',
      'take.lastReady': 'Last take',
      'take.download': 'Download WAV',
      'take.reviewReleaseMic': 'Release mic before reviewing the last Take.',
      'take.reviewPausedForMic': 'Take review paused while this phone has the mic.',
      'take.failed': 'Take {id} failed',
      'take.reconnectingError': 'Relay is reconnecting. Take was not changed.',
      'take.reject.participant-required': 'Take needs a Relay participant identity.',
      'take.reject.mix-not-active': 'There is no room mix to record yet.',
      'take.reject.song-required': 'Add a song before recording a Take.',
      'take.reject.product-blocked': 'Fix the room audio before recording a Take.',
      'take.reject.take-not-ready': 'The room is not ready to record yet.',
      'take.reject.take-active': 'A Take is already recording or finishing.',
      'take.reject.take-not-recording': 'There is no Take recording right now.',
      'take.reject.stale-take': 'That Stop belonged to an older Take.',
      'take.reject.invalid-take-id': 'Relay could not identify the Take to stop.',
      'take.reject.writer-failed': 'Relay could not start the Take recorder.',
      'take.reject.storage-unavailable': 'Recording storage is not available right now.',
      'take.reject.unknown': 'Take was rejected: {reason}',

      'listen.mute': 'Mute',
      'listen.unmute': 'Unmute',
      'listen.mutedForMic': 'Muted for Mic',
      'listen.mutedForSong': 'Muted for Song',
      'listen.adjust.micMuted': 'Muted while this phone has the mic. Sound restores automatically afterward.',
      'listen.adjust.songMuted': 'Muted while this phone plays the room song. Sound restores automatically afterward.',
      'listen.adjust.userMuted': 'Muted on this phone.',
      'listen.adjust.ready': 'Sound is on by default after your first interaction.',
      'listen.adjust.playing': 'Playing Relay mix on this phone.',
      'listen.connectingAudio': 'Connecting Relay audio…',
      'listen.reconnecting': 'Reconnecting…',
      'listen.buffering': 'Buffering…',
      'listen.firstInteraction': 'Sound starts after your first interaction.',
      'listen.micActive': 'Muted while the microphone is active.',
      'listen.resumed': 'Listening resumed.',
      'listen.retry': 'Tap Mute, then Unmute to retry audio.',
      'listen.startFailed': 'Could not start audio on this phone.',
      'listen.micStarting': 'Muted while the microphone starts.',
      'listen.handoffStarting': 'Muted while the microphone handoff starts.',
      'listen.micOwned': 'Muted while this phone has the mic.',
      'listen.songOwned': 'Muted while this phone plays the room song.',
      'listen.micFailedResume': 'Microphone did not start. Listening resumed.',

      'adjust.summary': 'Adjust',
      'adjust.done': 'Done',
      'adjust.heading': 'Adjust',
      'adjust.subtitle': 'Performance tuning',
      'adjust.roomMix': 'Room mix',
      'adjust.shared': 'Shared',
      'adjust.voice': 'Voice',
      'adjust.input': 'Input',
      'adjust.listening': 'Listening…',
      'adjust.voiceGainAria': 'Voice gain',
      'adjust.singNormally': 'Sing normally for a moment.',
      'adjust.useSuggestion': 'Use suggestion',
      'adjust.suggestionHelp': 'Relay will suggest a stable gain after it has enough voice.',
      'adjust.song': 'Song',
      'adjust.thisPhone': 'This phone',
      'adjust.localOnly': 'Local only',
      'adjust.listenVolume': 'Listen volume',
      'adjust.timing': 'Timing',
      'adjust.roomAlignment': 'Room alignment',
      'adjust.vocalFineTune': 'Vocal fine tune',
      'adjust.vocalFineTuneAria': 'Vocal fine tune',
      'adjust.vocalFineTuneHelp': 'Negative moves voice earlier; positive moves it later.',
      'adjust.waitingPlayback': 'Waiting for playback',
      'adjust.recalibrate': 'Realign',
      'adjust.recommendedGain': 'Recommended +{gain} dB',
      'adjust.soundsGood': 'Sounds good',
      'adjust.aboveSuggestion': '{amount} dB above suggestion',
      'adjust.belowSuggestion': '{amount} dB below suggestion',
      'adjust.useGain': 'Use +{gain} dB',
      'adjust.calibration.auto': 'Realign if timing sounds off.',
      'adjust.calibration.collecting': 'Aligning…',
      'adjust.calibration.rounds': '',
      'adjust.calibration.provisional': '',
      'adjust.calibration.complete': 'Aligned',
      'adjust.calibration.stale': '',
      'adjust.calibration.autoRetry': 'Waiting for usable audio; retrying automatically.',
      'adjust.calibration.failed': 'Unable to realign right now.',
      'adjust.calibration.noSignal': 'not enough signal',
      'adjust.calibration.fallback': 'Using current timing.',
      'timing.label': 'Timing',
      'timing.realign': 'Realign',
      'timing.aligning': 'Aligning…',
      'timing.unavailable': 'Unable to realign right now',
      'timing.reconnecting': 'Reconnecting…',

      'system.attention': 'System needs attention',
      'system.summary': 'System',
      'system.relay': 'Relay',
      'system.phones': 'Phones',
      'system.robot': 'Robot',
      'system.audio': 'Audio',
      'system.timing': 'Timing',
      'system.recording': 'Recording',
      'system.relayDetail': 'Room connection and lifecycle.',
      'system.phonesDetail': 'People and microphone state.',
      'system.robotDetail': 'Robot route state appears when System is opened.',
      'system.audioDetail': 'Room song and voice path.',
      'system.timingDetail': 'Performance alignment state.',
      'system.recordingDetail': 'Current and most recent Take state.',
      'system.connected': 'Connected',
      'system.reconnecting': 'Reconnecting',
      'system.people': '{count} {label}',
      'system.person': 'person',
      'system.peoplePlural': 'people',
      'system.needsAttention': 'Needs attention',
      'system.idle': 'Idle',
      'system.ok': 'OK',
      'system.live': 'Live',
      'system.starting': 'Starting',
      'system.recovering': 'Recovering',
      'system.ready': 'Ready',
      'system.unknown': 'Unknown',
      'system.timing.gettingReady': 'Getting ready',
      'system.timing.aligned': 'Aligned',
      'system.timing.recovering': 'Recovering',
      'system.take.available': 'Available',
      'system.take.recording': 'Recording',
      'system.take.finishing': 'Finishing',
      'system.take.lastReady': 'Last take ready',
      'system.attention.audio-unavailable': 'Room audio unavailable',
      'system.attention.robot-audio-unavailable': 'Robot audio unavailable',
      'system.attention.robot-route-invalid': 'Robot audio route needs attention',
      'system.attention.robot-player-unavailable': 'Robot player unavailable',
      'system.attention.song-clock-unavailable': 'Song playback unavailable',
      'system.attention.mic-reconnecting': 'Microphone reconnecting',
      'system.attention.mic-audio-stalled': 'Microphone audio interrupted',
      'system.attention.timing-recovering': 'Timing is recovering',
      'system.attention.timing-clamped': 'Timing needs attention',
      'system.attention.take-failed': 'Take failed',
      'system.micFree': 'Mic free',
      'system.micOwner': '{name} · live',
      'system.micOwnerReconnecting': '{name} · reconnecting',
      'system.noSong': 'No song',
      'system.songChangingPhones': 'Changing phones',
      'system.unavailable': 'Unavailable',
      'system.relayState': '{health} · {lifecycle} room state.',
      'system.phonesState': '{count} {label} online · {mic}.',
      'system.audioUnavailableDetail': 'The room audio path is unavailable. Open Technical details for backing evidence.',
      'system.songUnavailableDetail': 'Song playback needs attention. Open Technical details for playback evidence.',
      'system.audioState': '{song} · {mic}.',
      'system.timingIdleDetail': 'Timing stays out of the way until a performance needs it.',
      'system.timingState': '{state} timing state for the active performance.',
      'system.recordingState': '{state} recording state.',
      'system.robotProblemDetail': 'The active Robot audio path has a problem. Open Technical details for evidence.',
      'system.robotIdleDetail': 'The Robot route is not armed. Missing Robot audio is expected in this state.',
      'system.robotLegacy': 'Legacy route',
      'system.robotLegacyDetail': 'This session is using the compatibility backing route rather than the formal Robot route.',
      'system.robotReadyDetail': 'The formal Robot source and backing route are armed.',
      'system.robotNoIssue': 'No current Robot issue is surfaced by the product state.'
    },

    'zh-Hant': {
      'people.connecting': '連線中…',
      'people.reconnecting': '重新連線中…',
      'people.online': '{count} 人在線',
      'people.you': '你',
      'people.renameTitle': '修改暱稱',
      'people.nicknameLabel': '你的 Relay 暱稱',
      'people.reconnectingSuffix': '重新連線中',
      'people.micReconnectingSuffix': 'Mic 重新連線中',
      'language.label': '語言',
      'mic.label': 'Mic',
      'mic.take': '拿 Mic',
      'mic.release': '放 Mic',
      'mic.cancel': '取消',
      'mic.takeover': '接手 Mic',
      'mic.takeoverPrompt': '目前是 {name} 在使用 Mic。',
      'mic.takeoverPending': '正在接手 Mic…',
      'mic.startFailed': '無法啟動 Mic。',
      'mic.takeoverChangedOwner': 'Mic 已換成 {name}，要接手請再確認一次。',
      'mic.takeoverChanged': 'Mic 狀態已改變，請重新接手。',

      'song.label': '歌曲',
      'song.change': '換歌',
      'song.done': '完成',
      'song.roomSong': '房間歌曲',
      'song.pastePlaceholder': '貼上 YouTube 連結',
      'song.inputLabel': 'YouTube 網址或影片 ID',
      'song.load': '載入',
      'song.notLoaded': '尚未載入',
      'song.noteInitial': '貼上歌曲後，直接使用 YouTube 播放器。',
      'song.role.holder': '由這支手機播放',
      'song.role.preparing': '正在這支手機準備',
      'song.role.observer': '由另一支手機播放',
      'song.role.empty': '還沒有歌曲',
      'song.state.preparing': '準備中',
      'song.state.ended': '已結束',
      'song.state.playing': '播放中',
      'song.state.paused': '已暫停',
      'song.state.buffering': '緩衝中',
      'song.state.ready': '就緒',
      'song.buffered': '已緩衝 {percent}%',
      'song.bufferUnknown': '緩衝 --',
      'song.timelineJump': '偵測到時間跳動：{delta} 秒。',
      'song.bufferingIndependent': 'YouTube 正在緩衝；Mic 傳輸可以繼續運作。',
      'song.timelineAuthorized': '時間軸來自 YouTube 播放器；共用播放操作由 Relay 授權。',
      'song.observerCannotChange': '歌曲正在另一支手機播放；要從這支手機換歌，請先拿 Mic。',
      'song.requestingAction': '正在送出房間播放操作：{action}…',
      'song.handoffPrepared': '這支手機已準備好歌曲，Relay 正在等待安全切換播放。',
      'song.preparingHandoff': '正在為 Mic 交接準備房間歌曲；伺服器確認切換前不會開始播放。',
      'song.switchingHere': '正在把房間播放切到這支手機…',
      'song.movedWithMic': '房間播放已跟著 Mic 移走；這個播放器不再控制共用歌曲。',
      'song.handoffCancelled': '房間播放交接已取消；重新拿 Mic 即可再試一次。',
      'song.handoffComplete': '房間播放交接完成；這支手機現在跟隨共用歌曲。',
      'song.handoffAutoplayRecovery': '播放已移到這支手機，但瀏覽器暫停了音訊。請在 YouTube 播放器按一次播放。',
      'song.invalidVideo': '網址或影片 ID 無效',
      'song.invalidVideoHelp': '請貼上 YouTube watch、youtu.be、Shorts、Live、Embed 網址，或 11 字元影片 ID。',
      'song.initialHelp': '載入影片後直接使用可見的 YouTube 控制；共用歌曲操作由 Relay 授權，加入房間本身不會自動播放。',

      'voice.label': '人聲',
      'voice.connecting': '連線中…',
      'voice.gettingReady': '準備中…',
      'voice.keepSpeakerAudible': '請讓喇叭保持有聲。',
      'voice.songPreparing': '正在準備歌曲…',
      'voice.playbackMovingHere': '播放正在移到這支手機。',
      'voice.playbackChangingPhones': '播放正在切換手機。',
      'voice.micFree': 'Mic 目前空著',
      'voice.addSongToBegin': '可以直接拿 Mic，或加入歌曲作伴奏。',
      'voice.startingYours': '正在啟動你的 Mic…',
      'voice.waitingFirstAudio': '正在等這支手機送出第一段音訊。',
      'voice.interruptedYours': 'Mic 音訊中斷',
      'voice.mediaConnectedAudioStopped': '媒體連線仍在，但音訊已停止送達。',
      'voice.ready': '準備好了',
      'voice.takeMicWhenReady': '想唱時拿起 Mic。',
      'voice.reconnectingYours': '正在重新連接你的 Mic…',
      'voice.holdingPlace': 'Relay 會暫時保留你的 Mic。',
      'voice.live': '你正在唱',
      'voice.timingRecovering': 'Timing 正在恢復，你可以繼續唱。',
      'voice.toRoom': '你的聲音正在送到房間。',
      'voice.useSpeaker': '保持外放，Relay 才能正確聽到播放內容。',
      'voice.startingOther': '正在啟動麥克風…',
      'voice.interruptedOther': '麥克風音訊中斷',
      'voice.someone': '有人',
      'voice.reconnecting': '麥克風重新連線中…',
      'voice.singing': '正在唱',
      'voice.micUnavailable': '麥克風無法使用',
      'voice.httpsRequired': '請用 HTTPS 開啟 Relay，這支手機才能使用麥克風。',
      'voice.permissionRequired': '請允許瀏覽器使用麥克風後再試一次。',
      'voice.checkAccess': '請檢查這支手機的麥克風權限後再試一次。',

      'take.aria': '錄音',
      'take.record': '開始錄音',
      'take.stop': '停止',
      'take.finishing': '正在完成錄音…',
      'take.last': '上一段錄音 · {duration}',
      'take.lastReady': '上一段錄音',
      'take.download': '下載 WAV',
      'take.reviewReleaseMic': '請先放開 Mic，再播放上一段錄音。',
      'take.reviewPausedForMic': '這支手機拿到 Mic，錄音回放已暫停。',
      'take.failed': '錄音 {id} 失敗',
      'take.reconnectingError': 'Relay 正在重新連線，錄音狀態沒有變更。',
      'take.reject.participant-required': '錄音需要先建立 Relay 參與者身分。',
      'take.reject.mix-not-active': '目前還沒有可錄製的房間混音。',
      'take.reject.song-required': '加入歌曲後才能錄音。',
      'take.reject.product-blocked': '請先處理房間音訊問題再錄音。',
      'take.reject.take-not-ready': '房間目前還不能開始錄音。',
      'take.reject.take-active': '已有錄音正在進行或完成中。',
      'take.reject.take-not-recording': '目前沒有正在錄音。',
      'take.reject.stale-take': '這次停止操作屬於較舊的錄音。',
      'take.reject.invalid-take-id': 'Relay 無法辨識要停止的錄音。',
      'take.reject.writer-failed': 'Relay 無法啟動錄音器。',
      'take.reject.storage-unavailable': '目前無法使用錄音儲存空間。',
      'take.reject.unknown': '錄音被拒絕：{reason}',

      'listen.mute': '靜音',
      'listen.unmute': '取消靜音',
      'listen.mutedForMic': 'Mic 使用中，已靜音',
      'listen.mutedForSong': '歌曲由本機播放，已靜音',
      'listen.adjust.micMuted': '這支手機持有 Mic 時會自動靜音，結束後自動恢復。',
      'listen.adjust.songMuted': '這支手機播放房間歌曲時會自動靜音，交出播放後自動恢復。',
      'listen.adjust.userMuted': '這支手機已靜音。',
      'listen.adjust.ready': '第一次操作頁面後，聲音預設開啟。',
      'listen.adjust.playing': '這支手機正在播放 Relay 混音。',
      'listen.connectingAudio': '正在連接 Relay 音訊…',
      'listen.reconnecting': '重新連線中…',
      'listen.buffering': '緩衝中…',
      'listen.firstInteraction': '第一次操作頁面後開始播放聲音。',
      'listen.micActive': '麥克風使用中，已暫時靜音。',
      'listen.resumed': '收聽已恢復。',
      'listen.retry': '請先按靜音，再取消靜音以重試音訊。',
      'listen.startFailed': '無法在這支手機啟動音訊。',
      'listen.micStarting': '正在啟動麥克風，已暫時靜音。',
      'listen.handoffStarting': 'Mic 正在交接，已暫時靜音。',
      'listen.micOwned': '這支手機持有 Mic，已暫時靜音。',
      'listen.songOwned': '這支手機正在播放房間歌曲，Relay Listen 已暫時靜音。',
      'listen.micFailedResume': '麥克風未啟動，收聽已恢復。',

      'adjust.summary': '調整',
      'adjust.done': '完成',
      'adjust.heading': '調整',
      'adjust.subtitle': '演唱調整',
      'adjust.roomMix': '房間混音',
      'adjust.shared': '共用',
      'adjust.voice': '人聲',
      'adjust.input': '輸入',
      'adjust.listening': '監聽中…',
      'adjust.voiceGainAria': '人聲增益',
      'adjust.singNormally': '正常唱一小段即可。',
      'adjust.useSuggestion': '套用建議',
      'adjust.suggestionHelp': 'Relay 收到足夠的人聲後會提供穩定的增益建議。',
      'adjust.song': '歌曲',
      'adjust.thisPhone': '這支手機',
      'adjust.localOnly': '只影響本機',
      'adjust.listenVolume': '收聽音量',
      'adjust.timing': 'Timing',
      'adjust.roomAlignment': '房間對齊',
      'adjust.vocalFineTune': '人聲微調',
      'adjust.vocalFineTuneAria': '人聲時間微調',
      'adjust.vocalFineTuneHelp': '負值讓人聲更早，正值讓人聲更晚。',
      'adjust.waitingPlayback': '等待播放',
      'adjust.recalibrate': '重新對齊',
      'adjust.recommendedGain': '建議 +{gain} dB',
      'adjust.soundsGood': '目前很好',
      'adjust.aboveSuggestion': '比建議高 {amount} dB',
      'adjust.belowSuggestion': '比建議低 {amount} dB',
      'adjust.useGain': '套用 +{gain} dB',
      'adjust.calibration.auto': '如果時間對不上，可以重新對齊。',
      'adjust.calibration.collecting': '對齊中…',
      'adjust.calibration.rounds': '',
      'adjust.calibration.provisional': '',
      'adjust.calibration.complete': '已對齊',
      'adjust.calibration.stale': '',
      'adjust.calibration.autoRetry': '正在等待可用音訊，會自動重試。',
      'adjust.calibration.failed': '目前無法重新對齊。',
      'adjust.calibration.noSignal': '訊號不足',
      'adjust.calibration.fallback': '使用目前的時間對齊。',
      'timing.label': '時間對齊',
      'timing.realign': '重新對齊',
      'timing.aligning': '對齊中…',
      'timing.unavailable': '目前無法重新對齊',
      'timing.reconnecting': '重新連線中…',

      'system.attention': '系統需要處理',
      'system.summary': '系統',
      'system.relay': 'Relay',
      'system.phones': '手機',
      'system.robot': 'Robot',
      'system.audio': '音訊',
      'system.timing': 'Timing',
      'system.recording': '錄音',
      'system.relayDetail': '房間連線與 lifecycle。',
      'system.phonesDetail': '參與者與麥克風狀態。',
      'system.robotDetail': '開啟系統後顯示 Robot route 狀態。',
      'system.audioDetail': '房間歌曲與人聲路徑。',
      'system.timingDetail': '演唱對齊狀態。',
      'system.recordingDetail': '目前與最近一次錄音狀態。',
      'system.connected': '已連線',
      'system.reconnecting': '重新連線中',
      'system.people': '{count} {label}',
      'system.person': '人',
      'system.peoplePlural': '人',
      'system.needsAttention': '需要處理',
      'system.idle': '待機',
      'system.ok': '正常',
      'system.live': '進行中',
      'system.starting': '啟動中',
      'system.recovering': '恢復中',
      'system.ready': '就緒',
      'system.unknown': '未知',
      'system.timing.gettingReady': '準備中',
      'system.timing.aligned': '已對齊',
      'system.timing.recovering': '恢復中',
      'system.take.available': '可使用',
      'system.take.recording': '錄音中',
      'system.take.finishing': '完成中',
      'system.take.lastReady': '上一段錄音已完成',
      'system.attention.audio-unavailable': '房間音訊無法使用',
      'system.attention.robot-audio-unavailable': 'Robot 音訊無法使用',
      'system.attention.robot-route-invalid': 'Robot 音訊路徑需要處理',
      'system.attention.robot-player-unavailable': 'Robot 播放器無法使用',
      'system.attention.song-clock-unavailable': '歌曲播放無法使用',
      'system.attention.mic-reconnecting': '麥克風重新連線中',
      'system.attention.mic-audio-stalled': '麥克風音訊中斷',
      'system.attention.timing-recovering': 'Timing 正在恢復',
      'system.attention.timing-clamped': 'Timing 需要處理',
      'system.attention.take-failed': '錄音失敗',
      'system.micFree': 'Mic 空著',
      'system.micOwner': '{name} · 使用中',
      'system.micOwnerReconnecting': '{name} · 重新連線中',
      'system.noSong': '沒有歌曲',
      'system.songChangingPhones': '正在切換手機',
      'system.unavailable': '無法使用',
      'system.relayState': '{health} · {lifecycle} 房間狀態。',
      'system.phonesState': '{count} 人在線 · {mic}。',
      'system.audioUnavailableDetail': '房間音訊路徑無法使用；可在 Technical details 查看 backing 證據。',
      'system.songUnavailableDetail': '歌曲播放需要處理；可在 Technical details 查看播放證據。',
      'system.audioState': '{song} · {mic}。',
      'system.timingIdleDetail': '沒有演唱需要對齊時，Timing 不會介入。',
      'system.timingState': '目前演唱的 Timing 狀態：{state}。',
      'system.recordingState': '錄音狀態：{state}。',
      'system.robotProblemDetail': '目前 Robot 音訊路徑有問題；可在 Technical details 查看證據。',
      'system.robotIdleDetail': 'Robot route 尚未啟用；這個狀態下沒有 Robot 音訊是正常的。',
      'system.robotLegacy': 'Legacy route',
      'system.robotLegacyDetail': '這個 session 正在使用相容 backing route，而不是正式 Robot route。',
      'system.robotReadyDetail': '正式 Robot source 與 backing route 已啟用。',
      'system.robotNoIssue': '目前產品狀態沒有顯示 Robot 問題。'
    }
  };

  function normalizeLocale(value) {
    if (typeof value !== 'string') return null;
    const lower = value.trim().toLowerCase();
    if (lower === 'zh-hant' || lower === 'zh-tw' || lower === 'zh-hk' || lower.startsWith('zh-hant-')) return 'zh-Hant';
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
    return null;
  }

  function initialLocale() {
    const stored = normalizeLocale(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
    for (const language of navigator.languages ?? [navigator.language]) {
      const normalized = normalizeLocale(language);
      if (normalized) return normalized;
      if (typeof language === 'string' && language.toLowerCase().startsWith('zh')) return 'zh-Hant';
    }
    return DEFAULT_LOCALE;
  }

  let locale = initialLocale();

  function format(template, vars = {}) {
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
  }

  function registerMessages(bundle) {
    if (!bundle || typeof bundle !== 'object') return false;
    let registered = false;

    for (const [requestedLocale, additions] of Object.entries(bundle)) {
      const normalized = normalizeLocale(requestedLocale);
      if (!normalized || !SUPPORTED.has(normalized) || !additions || typeof additions !== 'object') continue;
      const table = messages[normalized];

      for (const [key, template] of Object.entries(additions)) {
        if (typeof template !== 'string') continue;
        if (Object.prototype.hasOwnProperty.call(table, key)) {
          if (table[key] !== template) {
            throw new Error(`Relay i18n key already registered: ${normalized}:${key}`);
          }
          continue;
        }
        table[key] = template;
        registered = true;
      }
    }

    if (registered) applyStatic();
    return registered;
  }

  function has(key) {
    return Object.prototype.hasOwnProperty.call(messages[locale] ?? {}, key)
      || Object.prototype.hasOwnProperty.call(messages[DEFAULT_LOCALE], key);
  }

  function t(key, vars = {}) {
    const table = messages[locale] ?? messages[DEFAULT_LOCALE];
    const fallback = messages[DEFAULT_LOCALE];
    const template = table[key] ?? fallback[key] ?? key;
    return format(template, vars);
  }

  function applyStatic(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.setAttribute('title', t(node.dataset.i18nTitle));
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
      node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
    });

    root.querySelectorAll('[data-relay-locale]').forEach((button) => {
      const active = button.dataset.relayLocale === locale;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.dataset.active = active ? 'true' : 'false';
    });
  }

  function setLocale(nextLocale, { persist = true } = {}) {
    const normalized = normalizeLocale(nextLocale);
    if (!normalized || !SUPPORTED.has(normalized)) return false;
    const changed = normalized !== locale;
    locale = normalized;
    document.documentElement.lang = locale;
    if (persist) localStorage.setItem(STORAGE_KEY, locale);
    applyStatic();
    applyAdjustSummary();
    if (changed) {
      window.dispatchEvent(new CustomEvent('relay-locale-changed', { detail: { locale } }));
    }
    return true;
  }

  function applyAdjustSummary() {
    const panel = document.querySelector('.adjust-panel');
    const summary = panel?.querySelector(':scope > summary');
    if (!summary) return;
    summary.textContent = t(panel.open ? 'adjust.done' : 'adjust.summary');
  }

  function bindLocaleControls() {
    document.querySelectorAll('[data-relay-locale]').forEach((button) => {
      button.addEventListener('click', () => setLocale(button.dataset.relayLocale));
    });
    const adjustPanel = document.querySelector('.adjust-panel');
    adjustPanel?.addEventListener('toggle', applyAdjustSummary);
    applyAdjustSummary();
  }

  window.relayI18n = {
    t,
    getLocale: () => locale,
    has,
    setLocale,
    applyStatic,
    registerMessages,
  };

  document.documentElement.lang = locale;
  applyStatic();
  bindLocaleControls();
})();
