import { groupHistory, historyFromStatus } from './take-history-model.js';

const root = document.querySelector('#last-take');
const recentButton = document.querySelector('#last-take-toggle');
const review = document.querySelector('#last-take-review');
const recordingPlayer = document.querySelector('#recording-player');
const recordingDownload = document.querySelector('#download-recording');

function localeIsChinese() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant';
}

function localCopy(english, traditionalChinese) {
  return localeIsChinese() ? traditionalChinese : english;
}

function ensureStyles() {
  if (document.querySelector('link[data-relay-take-history]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/take-history.css';
  link.dataset.relayTakeHistory = 'true';
  document.head.append(link);
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatRecordedAt(endedAtMs) {
  const value = Number(endedAtMs);
  if (!Number.isFinite(value)) return localCopy('Unknown time', '時間未知');
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const locale = localeIsChinese() ? 'zh-TW' : 'en';
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function verdictLabel(verdict) {
  if (verdict === 'clean') return localCopy('Clean', '乾淨');
  if (verdict === 'review') return localCopy('Review', '需檢查');
  if (verdict === 'degraded') return localCopy('Degraded', '品質下降');
  return localCopy('Ready', '完成');
}

function takeCount(count) {
  if (localeIsChinese()) return `${count} 段`;
  return `${count} ${count === 1 ? 'take' : 'takes'}`;
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

function createHistoryPanel(reviewNode) {
  const panel = document.createElement('details');
  panel.id = 'take-history-panel';
  panel.className = 'take-history-panel';

  const summary = document.createElement('summary');
  summary.textContent = localCopy('Recordings', '錄音');

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
  close.textContent = localCopy('Done', '完成');
  heading.append(headingCopy, close);

  const groups = document.createElement('div');
  groups.className = 'take-history-groups';

  sheet.append(heading, groups, reviewNode);
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
  ensureStyles();

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
    if (reviewNoticeKind === 'release') {
      return localCopy('Release mic before reviewing a Take.', '請先放開 Mic，再播放錄音。');
    }
    if (reviewNoticeKind === 'paused') {
      return localCopy(
        'Take review paused while this phone has the mic.',
        '這支手機拿到 Mic，錄音回放已暫停。',
      );
    }
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

  function groupLabel(group) {
    if (group.kind === 'song') return localCopy('Song', '歌曲');
    if (group.kind === 'voice') return localCopy('Voice only', '純人聲');
    return localCopy('Recovered recordings', '舊錄音');
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
      meta.textContent = `${formatDuration(entry.artifact.durationMs)} · ${verdictLabel(entry.qualityVerdict)}`;
      button.append(when, meta);
      button.addEventListener('click', () => {
        selectedTakeId = entry.takeId;
        reviewNoticeKind = null;
        renderSelection();
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
    selectedMeta.textContent = `${formatDuration(selected.artifact.durationMs)} · ${verdictLabel(selected.qualityVerdict)}`;

    const href = artifactUrl(selected.artifact.url);
    if (currentArtifactHref !== href) {
      recordingPlayer.pause();
      recordingPlayer.src = href;
      recordingPlayer.load();
      currentArtifactHref = href;
    }
    recordingPlayer.setAttribute('aria-label', localCopy('Selected Take playback', '所選錄音播放'));
    recordingDownload.href = href;
    recordingDownload.download = `relay-take-${shortTakeId(selected.takeId)}.wav`;
    recordingDownload.textContent = localCopy('Download WAV', '下載 WAV');
    renderNotice();
  }

  function renderRecent() {
    if (takeBusy || historyEntries.length === 0) {
      root.hidden = true;
      return;
    }
    const latest = historyEntries[0];
    root.hidden = false;
    recentButton.textContent = localCopy(
      `Last take · ${formatDuration(latest.artifact.durationMs)} · ${verdictLabel(latest.qualityVerdict)}`,
      `上一段錄音 · ${formatDuration(latest.artifact.durationMs)} · ${verdictLabel(latest.qualityVerdict)}`,
    );
  }

  function renderHistory() {
    headingLabel.textContent = localCopy('Recordings', '錄音');
    headingCount.textContent = takeCount(historyEntries.length);
    summary.textContent = localCopy('Recordings', '錄音');
    close.textContent = localCopy('Done', '完成');
    panel.setAttribute('aria-label', localCopy('Take history', '錄音紀錄'));

    if (!historyEntries.some((entry) => entry.takeId === selectedTakeId)) {
      selectedTakeId = historyEntries[0]?.takeId ?? null;
    }
    groupsNode.replaceChildren(...groupHistory(historyEntries).map(createGroup));
    renderSelection();
    renderRecent();
  }

  function closeHistory({ restoreFocus = true } = {}) {
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
  });

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
