import './live-i18n.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const strip = document.querySelector('.take-strip');
const startButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const status = document.querySelector('#recording-status');

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function blockedCopy(reason) {
  const key = {
    reconnecting: 'recording.blocked.reconnecting',
    'mix-not-active': 'recording.blocked.mix-not-active',
    'timing-calibration-active': 'recording.blocked.timing-calibration-active',
    'take-not-ready': 'recording.blocked.take-not-ready',
    'take-active': 'recording.blocked.take-active',
  }[reason] ?? 'recording.blocked.unavailable';
  return t(key);
}

function commandErrorCopy(reason) {
  if (reason === 'reconnecting') return t('recording.blocked.reconnecting');
  if (reason === 'storage-unavailable') return t('recording.error.storage-unavailable');
  return t('recording.error.generic');
}

if (strip && startButton && stopButton && status) {
  let lifecycle = 'idle';
  let previousLifecycle = 'idle';
  let latestState = window.relayRecordingState ?? null;
  let finishFlash = false;
  let finishTimer = null;

  strip.hidden = false;
  startButton.hidden = false;
  stopButton.hidden = true;
  startButton.disabled = true;
  stopButton.disabled = true;

  function setLifecycle(next) {
    previousLifecycle = lifecycle;
    lifecycle = typeof next === 'string' ? next : 'idle';
    strip.dataset.takeState = lifecycle;
  }

  function renderControls(detail) {
    const recording = lifecycle === 'recording';
    const finalizing = lifecycle === 'finalizing';
    const startPending = detail.startPending === true;
    const canStart = detail.canStart === true && !startPending && !recording && !finalizing;
    const canStop = detail.canStop === true && recording;

    strip.hidden = false;
    startButton.hidden = recording || finalizing;
    stopButton.hidden = !recording;
    startButton.disabled = !canStart;
    stopButton.disabled = !canStop;
    startButton.textContent = t('recording.record');
    stopButton.textContent = t('recording.stop');
  }

  function renderState(detail = latestState) {
    if (!detail || typeof detail !== 'object') return;
    latestState = detail;
    const nextLifecycle = String(detail.lifecycle ?? 'idle');
    if (nextLifecycle !== lifecycle) {
      lifecycle = nextLifecycle;
      strip.dataset.takeState = lifecycle;
    }

    renderControls(detail);

    if (finishFlash && lifecycle === 'ready') {
      status.textContent = t('recording.ready');
      return;
    }

    const commandError = detail.commandError?.reason;
    if (commandError) {
      status.textContent = commandErrorCopy(commandError);
      return;
    }

    if (detail.startPending === true && lifecycle !== 'recording' && lifecycle !== 'finalizing') {
      status.textContent = t('recording.starting');
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
        : `● ${formatDuration(elapsed)} · ${t('recording.blocked.reconnecting')}`;
      return;
    }

    if (lifecycle === 'finalizing') {
      status.textContent = authorityFresh
        ? t('recording.finishing')
        : `${t('recording.finishing')} · ${t('recording.blocked.reconnecting')}`;
      return;
    }

    if (lifecycle === 'failed') {
      status.textContent = t('recording.failed');
      return;
    }

    status.textContent = detail.canStart === true
      ? ''
      : blockedCopy(detail.startBlockedReason);
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
