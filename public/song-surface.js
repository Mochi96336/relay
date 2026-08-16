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
  [-1, 'Getting ready'],
  [0, 'Ended'],
  [1, 'Playing'],
  [2, 'Paused'],
  [3, 'Buffering'],
  [5, 'Ready'],
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

  function roomSnapshot(detail) {
    const timeline = detail?.timeline && typeof detail.timeline === 'object' ? detail.timeline : {};
    const room = detail?.room && typeof detail.room === 'object' ? detail.room : {};
    return { ...timeline, ...room };
  }

  function roleCopy(nextRole) {
    if (nextRole === 'holder') return 'Playing from this phone';
    if (nextRole === 'preparing') return 'Preparing on this phone';
    if (nextRole === 'observer') return 'Playing from another phone';
    if (nextRole === 'empty') return 'No song yet';
    return 'Connecting…';
  }

  function renderObserver(room) {
    const videoId = typeof room.videoId === 'string' ? room.videoId : null;
    const state = Number(room.state);
    const stateLabel = STATE_LABELS.get(state) ?? 'Room song';

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
    changeButton.textContent = editing ? 'Done' : 'Change song';

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
    changeButton.textContent = editing ? 'Done' : 'Change song';
    if (editing) input.focus();
  });

  window.addEventListener('relay:playback-view', render);
  stage.dataset.playbackRole = role;
  document.body.dataset.playbackRole = role;
}
