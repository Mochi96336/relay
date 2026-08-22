const strip = document.querySelector('.take-strip');
const startButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const status = document.querySelector('#recording-status');

function chinese() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant';
}

function localCopy(english, traditionalChinese) {
  return chinese() ? traditionalChinese : english;
}

function finishedCopy() {
  return localCopy('✓ Recording ready', '✓ 錄好了');
}

function reconnectingSuffix() {
  return localCopy('Reconnecting…', '重新連線中…');
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function shortTakeId(takeId) {
  return typeof takeId === 'string' ? takeId.slice(0, 8) : '—';
}

function errorCopy(reason) {
  const copy = {
    reconnecting: ['Reconnecting recording…', '錄音重新連線中…'],
    'participant-required': ['Recording needs a room identity.', '需要房間身分才能錄音'],
    'mix-not-active': ['Start singing or playback before recording.', '開始唱歌或播放後可以錄音'],
    'product-blocked': ['Fix the room audio before recording.', '先處理房間音訊問題'],
    'take-not-ready': ['Wait until the room is ready to record.', '房間準備完成後可以錄音'],
    'timing-calibration-active': ['Wait for timing calibration to finish.', '等待時間校準完成'],
    'take-active': ['A recording is already in progress.', '目前正在錄音'],
    'take-not-recording': ['There is no active recording.', '目前沒有錄音'],
    'stale-take': ['That recording is no longer active.', '那段錄音已經結束'],
    'invalid-take-id': ['Relay could not identify that recording.', 'Relay 無法辨識這段錄音'],
    'writer-failed': ['Relay could not start the recorder.', 'Relay 無法啟動錄音'],
    'storage-unavailable': ['Recording storage is unavailable.', '錄音儲存空間目前不可用'],
    unknown: ['Recording could not continue.', '錄音無法繼續'],
  };
  const [english, traditionalChinese] = copy[reason] ?? copy.unknown;
  return localCopy(english, traditionalChinese);
}

if (strip && startButton && stopButton && status) {
  let lifecycle = 'idle';
  let previousLifecycle = 'idle';
  let latestState = window.relayRecordingState ?? null;
  let finishFlash = false;
  let finishTimer = null;

  // Recording is not a permanently disabled control. It starts absent and only
  // enters the product surface when authoritative state says there is a real
  // action (or an active/finishing/error Take that must remain visible).
  strip.hidden = true;
  startButton.hidden = true;
  stopButton.hidden = true;
  startButton.disabled = true;
  stopButton.disabled = true;

  function setLifecycle(next) {
    previousLifecycle = lifecycle;
    lifecycle = typeof next === 'string' ? next : 'idle';
    strip.dataset.takeState = lifecycle;
  }

  function renderVisibility(detail) {
    const canStart = detail.canStart === true
      && lifecycle !== 'recording'
      && lifecycle !== 'finalizing';
    const canStop = detail.canStop === true && lifecycle === 'recording';
    const lifecycleVisible = lifecycle === 'recording'
      || lifecycle === 'finalizing'
      || lifecycle === 'failed';
    const errorVisible = Boolean(detail.commandError?.reason);

    startButton.hidden = !canStart;
    stopButton.hidden = !canStop;
    strip.hidden = !(canStart || lifecycleVisible || finishFlash || errorVisible);

    // Disabled controls are never used as readiness copy. If the server says
    // the action is unavailable it is absent; server authority still decides
    // when the real action enters the slot.
    startButton.disabled = !canStart;
    stopButton.disabled = !canStop;
  }

  function renderState(detail = latestState) {
    if (!detail || typeof detail !== 'object') return;
    latestState = detail;
    if (String(detail.lifecycle ?? 'idle') !== lifecycle) {
      lifecycle = String(detail.lifecycle ?? 'idle');
      strip.dataset.takeState = lifecycle;
    }

    renderVisibility(detail);

    if (finishFlash && lifecycle === 'ready') {
      status.textContent = finishedCopy();
      return;
    }

    const commandError = detail.commandError?.reason;
    if (commandError) {
      status.textContent = errorCopy(commandError);
      return;
    }

    const take = detail.take ?? null;
    const authorityFresh = detail.authorityFresh === true
      && detail.commandChannelFresh === true;
    if (lifecycle === 'recording' && take) {
      const startedAtMs = Number(take.startedAtMs);
      const snapshotObservedAt = Number(detail.snapshotObservedAt);
      const clockNow = authorityFresh
        ? Date.now()
        : Number.isFinite(snapshotObservedAt) ? snapshotObservedAt : startedAtMs;
      const elapsed = Number.isFinite(startedAtMs) && Number.isFinite(clockNow)
        ? clockNow - startedAtMs
        : 0;
      status.textContent = authorityFresh
        ? `● ${formatDuration(elapsed)}`
        : `● ${formatDuration(elapsed)} · ${reconnectingSuffix()}`;
      return;
    }

    if (lifecycle === 'finalizing') {
      status.textContent = authorityFresh
        ? localCopy('Finishing…', '正在完成錄音…')
        : `${localCopy('Finishing…', '正在完成錄音…')} · ${reconnectingSuffix()}`;
      return;
    }

    if (lifecycle === 'failed' && take) {
      status.textContent = localCopy(
        `Recording ${shortTakeId(take.takeId)} failed.`,
        `錄音 ${shortTakeId(take.takeId)} 失敗`,
      );
      return;
    }

    status.textContent = '';
  }

  function showFinishedFlash() {
    finishFlash = true;
    queueMicrotask(() => renderState(latestState));
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      finishTimer = null;
      finishFlash = false;
      renderState(latestState);
    }, 1_400);
  }

  // Raw Take lifecycle remains useful for detecting the exact recording -> ready
  // edge. All visible state comes from relay-recording-state below.
  window.addEventListener('relay-take-status', (event) => {
    const next = String(event.detail?.lifecycle ?? 'idle');
    setLifecycle(next);

    if (
      lifecycle === 'ready'
      && (previousLifecycle === 'recording' || previousLifecycle === 'finalizing')
    ) {
      showFinishedFlash();
      return;
    }

    if (lifecycle !== 'ready') {
      finishFlash = false;
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
    }
  });

  window.addEventListener('relay-recording-state', (event) => renderState(event.detail));
  window.addEventListener('relay-locale-changed', () => renderState(latestState));

  strip.dataset.takeState = lifecycle;
  renderState(latestState);
  window.dispatchEvent(new Event('relay-request-recording-state'));
}
