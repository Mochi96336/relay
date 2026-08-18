import './youtube-song-metadata.js';
import { canRecoverPlayback, playbackLeaderHealth } from './playback-recovery.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const stage = document.querySelector('.song-stage');
const form = document.querySelector('.youtube-form');
const input = document.querySelector('#youtube-url');
const playerShell = document.querySelector('.youtube-player-shell');
const localReadout = document.querySelector('.youtube-readout');
const localNote = document.querySelector('#youtube-note');
const deviceNote = document.querySelector('#song-device-note');
const changeButton = document.querySelector('#change-youtube');
const observer = document.querySelector('#song-observer');
const observerArtwork = document.querySelector('#room-song-artwork');
const observerState = document.querySelector('#room-song-state');
const observerTimeline = document.querySelector('#room-song-timeline');
const observerMeta = observer?.querySelector('.song-observer-meta');

const ROLES = new Set(['empty', 'holder', 'preparing', 'observer']);
const STATE_LABELS = new Map([
  [-1, 'song.state.preparing'],
  [0, 'song.state.ended'],
  [1, 'song.state.playing'],
  [2, 'song.state.paused'],
  [3, 'song.state.buffering'],
  [5, 'song.state.ready'],
]);

function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const whole = Math.floor(value);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

function localCopy(english, traditionalChinese) {
  return window.relayI18n?.getLocale?.() === 'zh-Hant' ? traditionalChinese : english;
}

function cleanMetadata(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

if (
  stage && form && input && playerShell && localReadout && localNote
  && deviceNote && changeButton && observer && observerArtwork
  && observerState && observerTimeline && observerMeta
) {
  let role = 'connecting';
  let editing = false;
  let lastVideoId = null;
  let lastRoom = {};
  let recoveryPending = false;

  const observerAuthor = document.createElement('span');
  observerAuthor.className = 'song-observer-author';
  observerAuthor.hidden = true;
  observerTimeline.insertAdjacentElement('beforebegin', observerAuthor);

  const observerPlaybackState = document.createElement('span');
  observerPlaybackState.className = 'song-observer-status';
  observerPlaybackState.hidden = true;
  observerTimeline.insertAdjacentElement('afterend', observerPlaybackState);

  const recoveryActions = document.createElement('div');
  recoveryActions.className = 'inline-actions playback-recovery-actions';
  recoveryActions.hidden = true;

  const recoverButton = document.createElement('button');
  recoverButton.id = 'recover-youtube';
  recoverButton.type = 'button';
  recoveryActions.append(recoverButton);
  observerMeta.append(recoveryActions);

  function roomSnapshot(detail) {
    const timeline = detail?.timeline && typeof detail.timeline === 'object' ? detail.timeline : {};
    const room = detail?.room && typeof detail.room === 'object' ? detail.room : {};
    return { ...timeline, ...room };
  }

  function roleCopy(nextRole) {
    if (nextRole === 'holder') return t('song.role.holder');
    if (nextRole === 'preparing') return t('song.role.preparing');
    if (nextRole === 'observer') return t('song.role.observer');
    if (nextRole === 'empty') return t('song.role.empty');
    return t('people.connecting');
  }

  function recoveryButtonCopy() {
    return recoveryPending
      ? localCopy('Taking over…', '正在接手…')
      : localCopy('Continue on this phone', '在這支手機繼續播放');
  }

  function renderRecovery(recoverable) {
    recoveryActions.hidden = !recoverable;
    recoverButton.disabled = !recoverable || recoveryPending;
    recoverButton.textContent = recoveryButtonCopy();
  }

  function renderDeviceNote(recoverable) {
    // Playback location is implementation context, not a persistent task. Keep
    // the heading quiet in the normal holder/observer/empty states and surface
    // it only while the user needs to understand a transition or recovery.
    const visible = recoverable || role === 'preparing' || role === 'connecting';
    deviceNote.hidden = !visible;
    if (!visible) {
      deviceNote.textContent = '';
      return;
    }
    deviceNote.textContent = recoverable
      ? localCopy('Playback controller unavailable', '播放主控已失聯')
      : roleCopy(role);
  }

  function renderObserver(room, recoverable) {
    const videoId = typeof room.videoId === 'string' ? room.videoId : null;
    const state = Number(room.state);
    const titleCopy = cleanMetadata(room.videoTitle) || t('song.roomSong');
    const authorCopy = cleanMetadata(room.videoAuthor);
    const stateLabel = recoverable
      ? localCopy('Playback interrupted', '播放已中斷')
      : STATE_LABELS.has(state)
        ? t(STATE_LABELS.get(state))
        : t('song.roomSong');

    // The song identity is the primary observer information. Playback state is
    // secondary and stays quiet while ordinary playback is healthy.
    observerState.textContent = titleCopy;
    observerAuthor.textContent = authorCopy;
    observerAuthor.hidden = !authorCopy;
    observerTimeline.textContent = `${formatTime(room.serverTime)} / ${formatTime(room.duration)}`;
    observerPlaybackState.textContent = stateLabel;
    observerPlaybackState.hidden = !recoverable && state === 1;
    renderRecovery(recoverable);

    if (videoId) {
      const nextSrc = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
      if (observerArtwork.src !== nextSrc) observerArtwork.src = nextSrc;
      observerArtwork.alt = '';
    } else {
      observerArtwork.removeAttribute('src');
      observerArtwork.alt = '';
    }
  }

  function render(event) {
    const detail = event?.detail ?? {};
    const nextRole = ROLES.has(detail.role) ? detail.role : 'empty';
    const room = roomSnapshot(detail);
    const videoId = typeof room.videoId === 'string' ? room.videoId : null;
    const previousRole = role;
    const recoverable = canRecoverPlayback({ role: nextRole, timeline: room });
    lastRoom = room;

    if (nextRole === 'empty') {
      editing = true;
    } else if (nextRole !== 'holder') {
      editing = false;
    } else if (previousRole !== 'holder' || (lastVideoId && videoId && videoId !== lastVideoId)) {
      editing = false;
    }

    if (!recoverable) recoveryPending = false;

    role = nextRole;
    lastVideoId = videoId;
    stage.dataset.playbackRole = role;
    stage.dataset.songEditing = editing ? 'true' : 'false';
    document.body.dataset.playbackRole = role;
    stage.dataset.playbackHealth = playbackLeaderHealth(room);
    document.body.dataset.playbackHealth = stage.dataset.playbackHealth;
    renderDeviceNote(recoverable);

    const holderWithSong = role === 'holder' && Boolean(videoId);
    form.hidden = role === 'preparing'
      || (role === 'observer' && !recoverable)
      || (holderWithSong && !editing);
    changeButton.hidden = !holderWithSong;
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    changeButton.setAttribute('aria-expanded', editing ? 'true' : 'false');

    const observerMode = role === 'observer';
    observer.hidden = !observerMode;
    playerShell.hidden = observerMode;
    localReadout.hidden = observerMode;
    localNote.hidden = observerMode;

    if (observerMode) renderObserver(room, recoverable);
    else renderRecovery(false);
  }

  changeButton.addEventListener('click', () => {
    if (role !== 'holder') return;
    editing = !editing;
    stage.dataset.songEditing = editing ? 'true' : 'false';
    form.hidden = !editing;
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    changeButton.setAttribute('aria-expanded', editing ? 'true' : 'false');
    if (editing) input.focus();
  });

  recoverButton.addEventListener('click', () => {
    if (recoveryPending || !canRecoverPlayback({ role, timeline: lastRoom })) return;
    recoveryPending = true;
    renderRecovery(true);
    window.dispatchEvent(new CustomEvent('relay:recover-room-song'));
  });

  function releaseRecoveryPending() {
    if (!recoveryPending) return;
    recoveryPending = false;
    renderRecovery(canRecoverPlayback({ role, timeline: lastRoom }));
  }

  window.addEventListener('relay:playback-view', render);
  window.addEventListener('relay:room-song-command-rejected', releaseRecoveryPending);
  window.addEventListener('relay:room-song-command-failed-ack', releaseRecoveryPending);
  window.addEventListener('relay:room-song-command-status', (event) => {
    if (event.detail?.pendingCommandId === null) releaseRecoveryPending();
  });
  window.addEventListener('relay-locale-changed', () => {
    const recoverable = canRecoverPlayback({ role, timeline: lastRoom });
    renderDeviceNote(recoverable);
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    if (role === 'observer') renderObserver(lastRoom, recoverable);
  });
  stage.dataset.playbackRole = role;
  stage.dataset.songEditing = 'false';
  document.body.dataset.playbackRole = role;
}
