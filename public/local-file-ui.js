import { localFileMix, localFileSurface, lostMicToAnother } from './local-file-mix.js';

// Copy lives in i18n.js: the menu item is static markup that i18n.js
// translates before this module loads.

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const $ = selector => document.querySelector(selector);

const moreMenu = $('#room-more');
const openButton = $('#open-local-file');
const openNote = $('#open-local-file-note');
const fileInput = $('#local-file-input');
const songStage = $('.song-stage');
const panel = $('#local-file-panel');
const title = $('#local-file-title');
const source = $('#local-file-source');
const closeButton = $('#local-file-close');
const transport = $('.local-file-transport');
const playButton = $('#local-file-play');
const seek = $('#local-file-seek');
const time = $('#local-file-time');
const note = $('#local-file-note');
const mixDetails = $('#local-file-mix');
const mixSummary = $('#local-file-mix-summary');
const music = $('#local-file-music');
const musicValue = $('#local-file-music-value');
const offset = $('#local-file-offset');
const offsetValue = $('#local-file-offset-value');
const latency = $('#local-file-latency');
const micGain = $('#mic-gain');

let micActive = window.relayActiveRole === 'publisher';
let roomSongPlaying = false;
// Room facts from ProductStatus: whose phone (if anyone's) is the song.
let roomLocalFile = null;
let roomMicOwnerId = null;
let roomMicOwnerName = null;
// The last participant seen holding the Mic; a reconnect grace's null in
// between does not count as a handoff.
let lastMicOwnerId = null;
let roomHasDuet = false;
let transientNote = null;
let seeking = false;

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function offsetLabel(ms) {
  if (ms > 0) return t('localFile.offsetEarlier', { ms });
  if (ms < 0) return t('localFile.offsetLater', { ms: -ms });
  return '0 ms';
}

function syncVocalGain() {
  if (micGain) localFileMix.setVocalGainDb(Number(micGain.value));
}

function renderMenu() {
  const blocked = roomHasDuet ? 'localFile.blockedDuet'
    : roomSongPlaying && !localFileMix.active ? 'localFile.blockedSong' : null;
  openButton.disabled = blocked !== null;
  openNote.textContent = blocked ? t(blocked) : '';
}

function renderOwner() {
  title.textContent = localFileMix.title ?? '';
  source.textContent = t('localFile.label');
  closeButton.hidden = false;
  transport.hidden = false;
  mixDetails.hidden = false;

  const playing = localFileMix.playing;
  const ready = micActive && localFileMix.attached;
  playButton.textContent = t(playing ? 'localFile.pause' : 'localFile.play');
  playButton.disabled = !playing && !ready;

  const duration = localFileMix.duration;
  seek.max = String(duration ?? 0);
  seek.disabled = duration === null;
  if (!seeking) seek.value = String(localFileMix.currentTime);
  time.textContent = `${clock(localFileMix.currentTime)} / ${clock(duration)}`;
  note.textContent = transientNote ?? (ready ? '' : t('localFile.needsMic'));

  music.value = String(Math.round(localFileMix.musicLevel * 100));
  musicValue.value = `${music.value}%`;
  offset.value = String(localFileMix.offsetMs);
  offsetValue.value = offsetLabel(localFileMix.offsetMs);
  mixSummary.value = `${musicValue.value} · ${offsetValue.value}`;
  latency.textContent = localFileMix.attached ? t('localFile.latency', { ms: localFileMix.roundTripMs }) : '';
}

function renderObserver() {
  title.textContent = roomLocalFile.title ?? t('localFile.untitled');
  source.textContent = t('localFile.from', { name: roomMicOwnerName ?? '' });
  closeButton.hidden = true;
  transport.hidden = true;
  mixDetails.hidden = true;
  note.textContent = '';
}

function render() {
  renderMenu();
  const surface = localFileSurface({
    fileOpen: localFileMix.active,
    myId: window.relayParticipantId,
    micOwnerId: roomMicOwnerId,
    roomLocalFile,
  });
  panel.hidden = surface === 'none';
  // Standby keeps the room's own song visible: someone else is singing.
  songStage.dataset.localFile = surface === 'owner' || surface === 'observer' ? 'on' : 'off';
  document.body.dataset.localFile = localFileMix.active ? 'on' : 'off';
  if (surface === 'owner' || surface === 'standby') renderOwner();
  else if (surface === 'observer') renderObserver();
}

openButton.addEventListener('click', () => {
  if (moreMenu) moreMenu.open = false;
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  transientNote = null;
  localFileMix.open(file);
});

closeButton.addEventListener('click', () => {
  transientNote = null;
  localFileMix.close();
});

playButton.addEventListener('click', () => {
  transientNote = null;
  if (localFileMix.playing) {
    localFileMix.pause();
    return;
  }
  syncVocalGain();
  void localFileMix.play();
});

seek.addEventListener('input', () => {
  seeking = true;
  time.textContent = `${clock(Number(seek.value))} / ${clock(localFileMix.duration)}`;
});
seek.addEventListener('change', () => {
  seeking = false;
  localFileMix.seek(Number(seek.value));
});

music.addEventListener('input', () => localFileMix.setMusicLevel(Number(music.value) / 100));
offset.addEventListener('input', () => localFileMix.setOffsetMs(Number(offset.value)));
micGain?.addEventListener('input', syncVocalGain);
micGain?.addEventListener('change', syncVocalGain);

localFileMix.addEventListener('change', (event) => {
  const kind = event.detail?.kind;
  if (kind === 'attached') syncVocalGain();
  if (kind === 'play-failed') transientNote = t('localFile.playFailed');
  if (kind === 'mode' || kind === 'file') transientNote = null;
  render();
});

window.addEventListener('relay-microphone-local-state', (event) => {
  micActive = Boolean(event.detail?.active);
  render();
});

window.addEventListener('relay-product-status', (event) => {
  const room = event.detail?.room;
  roomLocalFile = room?.localFile ?? null;
  roomMicOwnerId = room?.mic?.ownerId ?? null;
  roomMicOwnerName = room?.mic?.ownerNickname ?? null;
  if (roomMicOwnerId !== null) {
    // Someone took the Mic from this phone: its local song went with it.
    if (localFileMix.active && lostMicToAnother({
      previousOwnerId: lastMicOwnerId, nextOwnerId: roomMicOwnerId, myId: window.relayParticipantId,
    })) localFileMix.close();
    lastMicOwnerId = roomMicOwnerId;
  }
  roomHasDuet = Boolean(room?.duet);
  render();
});

// One song at a time: the room's YouTube song would reach Listen through the
// Robot on top of the one mixed here.
window.addEventListener('relay:playback-view', (event) => {
  const next = event.detail?.room?.state === 'playing';
  if (next && !roomSongPlaying && localFileMix.playing) {
    localFileMix.pause();
    transientNote = t('localFile.roomSongPaused');
  }
  roomSongPlaying = next;
  render();
});

window.addEventListener('relay-locale-changed', render);
render();
