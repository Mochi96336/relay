import './live-i18n.js';
import './youtube-song-metadata.js';
import {
  canChangeRoomSong,
  canRecoverPlayback,
  playbackLeaderHealth,
} from './playback-recovery.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const stage = document.querySelector('.song-stage');
const form = document.querySelector('.youtube-form');
const input = document.querySelector('#youtube-url');
const playerShell = document.querySelector('.youtube-player-shell');
const localReadout = document.querySelector('.youtube-readout');
const localNote = document.querySelector('#youtube-note');
const deviceNote = document.querySelector('#song-device-note');
const changeButton = document.querySelector('#change-youtube');
const headingTitle = document.querySelector('#song-heading-title');
const observer = document.querySelector('#song-observer');
const observerArtwork = document.querySelector('#room-song-artwork');
const observerState = document.querySelector('#room-song-state');
const observerTimeline = document.querySelector('#room-song-timeline');

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

function cleanMetadata(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

if (
  stage && form && input && playerShell && localReadout && localNote
  && deviceNote && changeButton && headingTitle && observer && observerArtwork
  && observerState && observerTimeline
) {
  let role = 'connecting';
  let editing = false;
  let editingVideoId = null;
  let lastVideoId = null;
  let lastRoom = {};
  let canEditCurrentSong = false;

  const observerAuthor = document.createElement('span');
  observerAuthor.className = 'song-observer-author';
  observerAuthor.hidden = true;
  observerTimeline.insertAdjacentElement('beforebegin', observerAuthor);

  const observerPlaybackState = document.createElement('span');
  observerPlaybackState.className = 'song-observer-status';
  observerPlaybackState.hidden = true;
  observerTimeline.insertAdjacentElement('afterend', observerPlaybackState);

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
      ? t('song.playbackControllerUnavailable')
      : roleCopy(role);
  }

  function renderObserver(room, recoverable) {
    const videoId = typeof room.videoId === 'string' ? room.videoId : null;
    const state = Number(room.state);
    const titleCopy = cleanMetadata(room.videoTitle) || t('song.roomSong');
    const authorCopy = cleanMetadata(room.videoAuthor);
    const stateLabel = recoverable
      ? t('song.playbackInterrupted')
      : STATE_LABELS.has(state)
        ? t(STATE_LABELS.get(state))
        : t('song.roomSong');

    // Observers get the full compact snapshot. Playback holders project only
    // the title into the heading row above the real YouTube controls.
    headingTitle.textContent = titleCopy;
    observerState.textContent = titleCopy;
    observerAuthor.textContent = authorCopy;
    observerAuthor.hidden = !authorCopy;
    observerTimeline.textContent = `${formatTime(room.serverTime)} / ${formatTime(room.duration)}`;
    observerPlaybackState.textContent = stateLabel;
    observerPlaybackState.hidden = !recoverable && state === 1;

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
    const recoverable = canRecoverPlayback({ role: nextRole, timeline: room });
    const canChange = canChangeRoomSong({
      role: nextRole,
      timeline: room,
      isMicOwner: detail.isMicOwner === true,
      isMicFree: detail.isMicFree === true,
    });
    const handoffInProgress = nextRole === 'preparing'
      || (typeof room.handoffState === 'string' && room.handoffState !== 'idle');
    lastRoom = room;

    if (nextRole === 'empty' && !videoId && canChange) {
      editing = true;
      editingVideoId = null;
    } else if (editing && editingVideoId !== videoId) {
      editing = false;
      editingVideoId = null;
    } else if (!canChange && !handoffInProgress) {
      editing = false;
      editingVideoId = null;
    }

    role = nextRole;
    lastVideoId = videoId;
    canEditCurrentSong = canChange;
    stage.dataset.playbackRole = role;
    stage.dataset.songEditing = editing ? 'true' : 'false';
    document.body.dataset.playbackRole = role;
    stage.dataset.playbackHealth = playbackLeaderHealth(room);
    document.body.dataset.playbackHealth = stage.dataset.playbackHealth;
    renderDeviceNote(recoverable);

    const holderWithSong = role === 'holder' && Boolean(videoId);
    headingTitle.hidden = !holderWithSong;
    form.hidden = role === 'preparing' || !canChange || (Boolean(videoId) && !editing);
    changeButton.hidden = !canChange || !videoId;
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    changeButton.setAttribute('aria-expanded', editing ? 'true' : 'false');

    // Once the old playback transport disappears, resolvePlaybackRole returns
    // `empty` so a new controller may recover the room. A Song still exists,
    // though: keep showing its compact music surface instead of replacing it
    // with an empty iframe/form. Mic state decides who receives the edit action.
    const observerMode = role === 'observer' || (role === 'empty' && Boolean(videoId));
    const metadataMode = observerMode || holderWithSong;
    observer.hidden = !observerMode;
    playerShell.hidden = observerMode;
    localReadout.hidden = observerMode;
    localNote.hidden = observerMode;

    if (metadataMode) renderObserver(room, recoverable);
  }

  changeButton.addEventListener('click', () => {
    if (!canEditCurrentSong) return;
    // Opening is derived from the painted state so an authoritative playback
    // refresh cannot leave the local boolean one click ahead of the form.
    editing = form.hidden || stage.dataset.songEditing !== 'true';
    editingVideoId = editing ? lastVideoId : null;
    stage.dataset.songEditing = editing ? 'true' : 'false';
    form.hidden = !editing;
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    changeButton.setAttribute('aria-expanded', editing ? 'true' : 'false');
    if (editing) input.focus();
  });

  window.addEventListener('relay:playback-view', render);
  window.addEventListener('relay-locale-changed', () => {
    const recoverable = canRecoverPlayback({ role, timeline: lastRoom });
    renderDeviceNote(recoverable);
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    if (
      role === 'observer'
      || (Boolean(lastVideoId) && (role === 'holder' || role === 'empty'))
    ) {
      renderObserver(lastRoom, recoverable);
    }
  });
  stage.dataset.playbackRole = role;
  stage.dataset.songEditing = 'false';
  document.body.dataset.playbackRole = role;
}
