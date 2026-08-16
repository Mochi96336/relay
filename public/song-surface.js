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

if (
  stage && form && input && playerShell && localReadout && localNote
  && deviceNote && changeButton && observer && observerArtwork
  && observerState && observerTimeline
) {
  let role = 'connecting';
  let editing = false;
  let lastVideoId = null;
  let lastRoom = {};

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

  function renderObserver(room) {
    const videoId = typeof room.videoId === 'string' ? room.videoId : null;
    const state = Number(room.state);
    const stateLabel = STATE_LABELS.has(state) ? t(STATE_LABELS.get(state)) : t('song.roomSong');

    observerState.textContent = stateLabel;
    observerTimeline.textContent = `${formatTime(room.serverTime)} / ${formatTime(room.duration)}`;

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
    lastRoom = room;

    if (nextRole === 'empty') {
      editing = true;
    } else if (nextRole !== 'holder') {
      editing = false;
    } else if (previousRole !== 'holder' || (lastVideoId && videoId && videoId !== lastVideoId)) {
      editing = false;
    }

    role = nextRole;
    lastVideoId = videoId;
    stage.dataset.playbackRole = role;
    document.body.dataset.playbackRole = role;
    deviceNote.textContent = roleCopy(role);

    const holderWithSong = role === 'holder' && Boolean(videoId);
    form.hidden = role === 'observer' || role === 'preparing' || (holderWithSong && !editing);
    changeButton.hidden = !holderWithSong;
    changeButton.textContent = editing ? t('song.done') : t('song.change');

    const observerMode = role === 'observer';
    observer.hidden = !observerMode;
    playerShell.hidden = observerMode;
    localReadout.hidden = observerMode;
    localNote.hidden = observerMode;

    if (observerMode) renderObserver(room);
  }

  changeButton.addEventListener('click', () => {
    if (role !== 'holder') return;
    editing = !editing;
    form.hidden = !editing;
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    if (editing) input.focus();
  });

  window.addEventListener('relay:playback-view', render);
  window.addEventListener('relay-locale-changed', () => {
    deviceNote.textContent = roleCopy(role);
    changeButton.textContent = editing ? t('song.done') : t('song.change');
    if (role === 'observer') renderObserver(lastRoom);
  });
  stage.dataset.playbackRole = role;
  document.body.dataset.playbackRole = role;
}
