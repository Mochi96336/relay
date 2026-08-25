import './live-i18n.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const strip = document.querySelector('.take-strip');
const startButton = document.querySelector('#start-recording');
const stopButton = document.querySelector('#stop-recording');
const status = document.querySelector('#recording-status');

const START_POLICY_BLOCK_REASONS = new Set([
  'mix-not-active',
  'timing-calibration-active',
  'mic-required',
  'mic-starting',
  'mic-reconnecting',
  'mic-audio-stalled',
  'room-blocked',
  'take-active',
]);

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function blockingIssueCopy(issue) {
  const key = {
    'backing-not-ready': 'recording.blocked.issue.backing-not-ready',
    'backing-unavailable': 'recording.blocked.issue.backing-unavailable',
    'backing-stalled': 'recording.blocked.issue.backing-stalled',
    'backing-route-mismatch': 'recording.blocked.issue.backing-route-mismatch',
    'robot-source-unavailable': 'recording.blocked.issue.robot-source-unavailable',
    'song-clock-unavailable': 'recording.blocked.issue.song-clock-unavailable',
  }[issue?.cause];
  return key ? t(key) : t('recording.blocked.room-blocked');
}

function blockedCopy(reason, issue) {
  if (reason === 'room-blocked') return blockingIssueCopy(issue);
  const key = {
    reconnecting: 'recording.blocked.reconnecting',
    'mix-not-active': 'recording.blocked.mix-not-active',
    'timing-calibration-active': 'recording.blocked.timing-calibration-active',
    'mic-required': 'recording.blocked.mic-required',
    'mic-starting': 'recording.blocked.mic-starting',
    'mic-reconnecting': 'recording.blocked.mic-reconnecting',
    'mic-audio-stalled': 'recording.blocked.mic-audio-stalled',
    'take-active': 'recording.blocked.take-active',
  }[reason] ?? 'recording.blocked.unavailable';
  return t(key);
}

function commandErrorCopy(reason, issue) {
  if (reason === 'reconnecting') return t('recording.blocked.reconnecting');
  if (reason === 'storage-unavailable') return t('recording.error.storage-unavailable');
  if (START_POLICY_BLOCK_REASONS.has(reason)) return blockedCopy(reason, issue);
  return t('recording.error.generic');
}

if (strip && startButton && stopButton && status) {
  let lifecycle = 'idle';
  let previousLifecycle = 'idle';
  let latestState = window.relayRecordingState ?? null;
  let finishFlash = false;
  let finishTimer = null;

  strip.hidden = false;
  strip.dataset.recordingSlot = 'action';
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

  function presentSlot(mode, copy, detail = latestState) {
    strip.dataset.recordingSlot = mode;
    status.textContent = copy;

    if (mode === 'status') {
      startButton.hidden = true;
      return;
    }

    if (mode === 'status-action') {
      startButton.hidden = false;
      startButton.disabled = detail?.canStart !== true;
      startButton.textContent = t('recording.record');
    }
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
      presentSlot('status', t('recording.ready'), detail);
      return;
    }

    const commandError = detail.commandError?.reason;
    if (commandError) {
      const blockingIssue = commandError === 'room-blocked'
        && detail.startBlockedReason === 'room-blocked'
        ? detail.startBlockingIssue
        : null;
      const copy = commandErrorCopy(commandError, blockingIssue);
      if (lifecycle !== 'recording' && lifecycle !== 'finalizing' && detail.canStart === true) {
        presentSlot('status-action', copy, detail);
      } else if (lifecycle !== 'recording' && lifecycle !== 'finalizing') {
        presentSlot('status', copy, detail);
      } else {
        strip.dataset.recordingSlot = lifecycle === 'recording' ? 'recording' : 'status';
        status.textContent = copy;
      }
      return;
    }

    if (detail.startPending === true && lifecycle !== 'recording' && lifecycle !== 'finalizing') {
      presentSlot('status', t('recording.starting'), detail);
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
      strip.dataset.recordingSlot = 'recording';
      status.textContent = authorityFresh
        ? `● ${formatDuration(elapsed)}`
        : `● ${formatDuration(elapsed)} · ${t('recording.blocked.reconnecting')}`;
      return;
    }

    if (lifecycle === 'finalizing') {
      presentSlot(
        'status',
        authorityFresh
          ? t('recording.finishing')
          : `${t('recording.finishing')} · ${t('recording.blocked.reconnecting')}`,
        detail,
      );
      return;
    }

    if (lifecycle === 'failed') {
      const copy = t('recording.failed');
      presentSlot(detail.canStart === true ? 'status-action' : 'status', copy, detail);
      return;
    }

    if (detail.canStart === true) {
      strip.dataset.recordingSlot = 'action';
      status.textContent = '';
      return;
    }

    presentSlot(
      'status',
      blockedCopy(detail.startBlockedReason, detail.startBlockingIssue),
      detail,
    );
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
