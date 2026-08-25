import './live-i18n.js';
import { groupHistory, historyFromStatus } from './take-history-model.js';

const root = document.querySelector('#last-take');
const recentButton = document.querySelector('#last-take-toggle');
const review = document.querySelector('#last-take-review');
const recordingPlayer = document.querySelector('#recording-player');
const recordingDownload = document.querySelector('#download-recording');
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;

function intlLocale() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant' ? 'zh-TW' : 'en';
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatRecordedAt(endedAtMs) {
  const value = Number(endedAtMs);
  if (!Number.isFinite(value)) return t('takeHistory.unknownTime');
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(intlLocale(), sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function takeCount(count) {
  return t(count === 1 ? 'takeHistory.count.one' : 'takeHistory.count.many', { count });
}

function shortTakeId(takeId) {
  return typeof takeId === 'string' ? takeId.slice(0, 8) : 'take';
}

function artifactUrl(relativeUrl) {
  const url = new URL(relativeUrl, location.origin);
  const key = new URLSearchParams(location.search).get('key');
  if (key) url.searchParams.set('key', key);
  return url.toString();
}

function dispatchReviewPlayback(active) {
  window.dispatchEvent(new CustomEvent('relay-take-review-playback', {
    detail: { active: active === true },
  }));
}

function createHistoryPanel(reviewNode) {
  const panel = document.createElement('details');
  panel.id = 'take-history-panel';
  panel.className = 'take-history-panel';

  const summary = document.createElement('summary');
  summary.textContent = t('takeHistory.summary');

  const sheet = document.createElement('div');
  sheet.className = 'take-history-sheet';

  const heading = document.createElement('div');
  heading.className = 'take-history-panel-heading';
  const headingCopy = document.createElement('div');
  headingCopy.className = 'take-history-heading-copy';
  const headingLabel = document.createElement('strong');
  const headingCount = document.createElement('span');
  headingCopy.append(headingLabel, headingCount);
  const close = document.createElement('button');
  close.id = 'close-take-history';
  close.className = 'text-action panel-done';
  close.type = 'button';
  close.textContent = t('takeHistory.done');
  heading.append(headingCopy, close);

  const groups = document.createElement('div');
  groups.className = 'take-history-groups';

  sheet.append(heading, reviewNode, groups);
  panel.append(summary, sheet);
  document.querySelector('.live-shell')?.append(panel);

  return {
    panel,
    summary,
    sheet,
    headingLabel,
    headingCount,
    close,
    groups,
  };
}

if (root && recentButton && review && recordingPlayer && recordingDownload) {
  root.classList.remove('last-take');
  root.classList.add('recent-take');
  review.classList.remove('take-review');
  review.classList.add('take-history-review');

  const {
    panel,
    summary,
    headingLabel,
    headingCount,
    close,
    groups: groupsNode,
  } = createHistoryPanel(review);

  const selectedSummary = document.createElement('div');
  selectedSummary.className = 'take-history-selected';
  const selectedWhen = document.createElement('strong');
  const selectedMeta = document.createElement('span');
  selectedSummary.append(selectedWhen, selectedMeta);

  const reviewFooter = document.createElement('div');
  reviewFooter.className = 'take-history-review-footer';
  const reviewNoticeNode = document.createElement('span');
  reviewNoticeNode.className = 'take-history-notice';
  reviewNoticeNode.setAttribute('aria-live', 'polite');
  reviewFooter.append(reviewNoticeNode, recordingDownload);

  review.replaceChildren(selectedSummary, recordingPlayer, reviewFooter);

  let historyEntries = [];
  let selectedTakeId = null;
  let currentArtifactHref = null;
  let takeBusy = false;
  let localMicActive = false;
  let roomMicActive = false;
  let reviewNoticeKind = null;

  function phoneOwnsMic() {
    return localMicActive || roomMicActive;
  }

  function noticeCopy() {
    if (reviewNoticeKind === 'release') return t('takeHistory.notice.release');
    if (reviewNoticeKind === 'paused') return t('takeHistory.notice.paused');
    return '';
  }

  function renderNotice() {
    reviewNoticeNode.textContent = noticeCopy();
  }

  function stopReviewForMic(kind) {
    if (!recordingPlayer.paused) recordingPlayer.pause();
    reviewNoticeKind = kind;
    renderNotice();
  }

  function reconcileMicFeedbackGuard() {
    if (phoneOwnsMic()) {
      if (!recordingPlayer.paused) stopReviewForMic('paused');
      return;
    }
    if (reviewNoticeKind) {
      reviewNoticeKind = null;
      renderNotice();
    }
  }

  function revealReviewAfterSelection() {
    const sheet = panel.querySelector('.take-history-sheet');
    if (!sheet) return;
    const sheetRect = sheet.getBoundingClientRect();
    const reviewRect = review.getBoundingClientRect();
    const headingRect = panel.querySelector('.take-history-panel-heading')?.getBoundingClientRect();
    const visibleTop = Math.max(sheetRect.top, headingRect?.bottom ?? sheetRect.top);
    if (reviewRect.top >= visibleTop && reviewRect.bottom <= sheetRect.bottom) return;
    sheet.scrollTop += reviewRect.top - visibleTop;
  }

  function groupLabel(group) {
    if (group.kind === 'song') return t('takeHistory.group.song');
    if (group.kind === 'voice') return t('takeHistory.group.voice');
    return t('takeHistory.group.recovered');
  }

  function createGroup(group) {
    const section = document.createElement('section');
    section.className = 'take-history-group';

    const groupHeading = document.createElement('div');
    groupHeading.className = 'take-history-group-heading';

    if (group.kind === 'song' && group.videoId) {
      const artwork = document.createElement('img');
      artwork.className = 'take-history-artwork';
      artwork.src = `https://i.ytimg.com/vi/${encodeURIComponent(group.videoId)}/hqdefault.jpg`;
      artwork.alt = '';
      artwork.loading = 'lazy';
      groupHeading.append(artwork);
    }

    const copy = document.createElement('div');
    copy.className = 'take-history-group-copy';
    const label = document.createElement('strong');
    label.textContent = groupLabel(group);
    const count = document.createElement('span');
    count.textContent = takeCount(group.entries.length);
    copy.append(label, count);
    groupHeading.append(copy);

    const list = document.createElement('div');
    list.className = 'take-history-list';
    for (const entry of group.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'take-history-item';
      button.dataset.takeId = entry.takeId;
      button.setAttribute('aria-pressed', String(entry.takeId === selectedTakeId));

      const when = document.createElement('strong');
      when.textContent = formatRecordedAt(entry.endedAtMs);
      const meta = document.createElement('span');
      meta.textContent = formatDuration(entry.artifact.durationMs);
      button.append(when, meta);
      button.addEventListener('click', (event) => {
        const keyboardActivation = event.detail === 0;
        selectedTakeId = entry.takeId;
        reviewNoticeKind = null;
        renderSelection();
        revealReviewAfterSelection();
        if (keyboardActivation) recordingPlayer.focus({ preventScroll: true });
      });
      list.append(button);
    }

    section.append(groupHeading, list);
    return section;
  }

  function renderSelection() {
    for (const button of groupsNode.querySelectorAll('[data-take-id]')) {
      const selected = button.dataset.takeId === selectedTakeId;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }

    const selected = historyEntries.find((entry) => entry.takeId === selectedTakeId) ?? null;
    if (!selected) {
      review.hidden = true;
      recordingPlayer.pause();
      recordingPlayer.removeAttribute('src');
      recordingPlayer.load();
      recordingDownload.removeAttribute('href');
      recordingDownload.removeAttribute('download');
      currentArtifactHref = null;
      return;
    }

    review.hidden = false;
    selectedWhen.textContent = formatRecordedAt(selected.endedAtMs);
    selectedMeta.textContent = formatDuration(selected.artifact.durationMs);

    const href = artifactUrl(selected.artifact.url);
    if (currentArtifactHref !== href) {
      recordingPlayer.pause();
      recordingPlayer.src = href;
      recordingPlayer.load();
      currentArtifactHref = href;
    }
    recordingPlayer.setAttribute('aria-label', t('takeHistory.selectedPlaybackAria'));
    recordingDownload.href = href;
    recordingDownload.download = `relay-take-${shortTakeId(selected.takeId)}.wav`;
    recordingDownload.textContent = t('takeHistory.download');
    renderNotice();
  }

  function renderRecent() {
    if (takeBusy || historyEntries.length === 0) {
      root.hidden = true;
      return;
    }
    const latest = historyEntries[0];
    root.hidden = false;
    recentButton.textContent = t('takeHistory.last', {
      duration: formatDuration(latest.artifact.durationMs),
    });
  }

  function renderHistory() {
    headingLabel.textContent = t('takeHistory.summary');
    headingCount.textContent = takeCount(historyEntries.length);
    summary.textContent = t('takeHistory.summary');
    close.textContent = t('takeHistory.done');
    panel.setAttribute('aria-label', t('takeHistory.panelAria'));

    if (!historyEntries.some((entry) => entry.takeId === selectedTakeId)) {
      selectedTakeId = historyEntries[0]?.takeId ?? null;
    }
    groupsNode.replaceChildren(...groupHistory(historyEntries).map(createGroup));
    renderSelection();
    renderRecent();
  }

  function closeHistory({ restoreFocus = true } = {}) {
    if (!recordingPlayer.paused) recordingPlayer.pause();
    panel.open = false;
    recentButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !root.hidden) recentButton.focus({ preventScroll: true });
  }

  function requestOpenHistory() {
    const latest = historyEntries[0];
    if (!latest || takeBusy) return;
    selectedTakeId = latest.takeId;
    reviewNoticeKind = null;
    renderHistory();
    // This module owns recording/history state only. Live IA owns which
    // secondary surface is visible and will close System/header menus before
    // opening this dynamically-created panel.
    window.dispatchEvent(new Event('relay-open-take-history'));
  }

  recentButton.addEventListener('click', requestOpenHistory);
  close.addEventListener('click', () => closeHistory());
  panel.addEventListener('click', (event) => {
    if (event.target === panel) closeHistory();
  });
  panel.addEventListener('toggle', () => {
    recentButton.setAttribute('aria-expanded', String(panel.open));
    if (!panel.open && !recordingPlayer.paused) recordingPlayer.pause();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.open) closeHistory();
  });

  recordingPlayer.addEventListener('play', () => {
    if (phoneOwnsMic()) {
      stopReviewForMic('release');
      return;
    }
    reviewNoticeKind = null;
    renderNotice();
    dispatchReviewPlayback(true);
  });
  recordingPlayer.addEventListener('pause', () => dispatchReviewPlayback(false));
  recordingPlayer.addEventListener('ended', () => dispatchReviewPlayback(false));
  recordingPlayer.addEventListener('emptied', () => dispatchReviewPlayback(false));

  window.addEventListener('relay-take-status', (event) => {
    const status = event.detail;
    takeBusy = status?.lifecycle === 'recording' || status?.lifecycle === 'finalizing';
    if (takeBusy) {
      if (!recordingPlayer.paused) recordingPlayer.pause();
      if (panel.open) closeHistory({ restoreFocus: false });
    }
    historyEntries = historyFromStatus(status, historyEntries);
    if (status?.lifecycle === 'ready' && typeof status.take?.takeId === 'string') {
      selectedTakeId = status.take.takeId;
    }
    renderHistory();
  });

  window.addEventListener('relay-locale-changed', renderHistory);

  window.addEventListener('relay-microphone-local-state', (event) => {
    localMicActive = event.detail?.active === true;
    reconcileMicFeedbackGuard();
  });

  window.addEventListener('relay-microphone-started', () => {
    if (recordingPlayer.paused) return;
    stopReviewForMic('paused');
  });

  window.addEventListener('relay-microphone-ended', reconcileMicFeedbackGuard);

  window.addEventListener('relay-session-status', (event) => {
    const participantId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId
      : null;
    const ownerId = typeof event.detail?.micOwnerId === 'string'
      ? event.detail.micOwnerId
      : null;
    const nextRoomMicActive = Boolean(participantId && ownerId === participantId);
    if (roomMicActive === nextRoomMicActive) return;
    roomMicActive = nextRoomMicActive;
    reconcileMicFeedbackGuard();
  });

  Promise.resolve(window.relayIdentityReady).then(() => {
    window.dispatchEvent(new Event('relay-request-session-status'));
  });

  root.hidden = true;
  review.hidden = true;
  renderHistory();
}
