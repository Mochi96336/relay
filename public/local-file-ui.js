import { localFileMix } from './local-file-mix.js';

window.relayI18n?.registerMessages({
  en: {
    'localFile.open': 'Open local audio file',
    'localFile.label': 'Local file',
    'localFile.from': "Local file · {name}'s phone",
    'localFile.untitled': 'Local song',
    'localFile.close': 'Close',
    'localFile.play': 'Play',
    'localFile.pause': 'Pause',
    'localFile.position': 'Position',
    'localFile.mix': 'Mix',
    'localFile.music': 'Song',
    'localFile.offset': 'Voice timing',
    'localFile.offsetEarlier': '{ms} ms earlier',
    'localFile.offsetLater': '{ms} ms later',
    'localFile.latency': 'Device delay of {ms} ms is already compensated.',
    'localFile.needsMic': 'Take Mic to play.',
    'localFile.roomSongPaused': 'Paused because the room song started.',
    'localFile.playFailed': 'This file cannot be played.',
    'localFile.blockedSong': 'Pause the YouTube song first.',
    'localFile.blockedDuet': 'Not available while a second Mic is in.',
  },
  'zh-Hant': {
    'localFile.open': '打開本機音檔',
    'localFile.label': '本機音檔',
    'localFile.from': '本機音檔 · {name} 的手機',
    'localFile.untitled': '本機歌曲',
    'localFile.close': '關閉',
    'localFile.play': '播放',
    'localFile.pause': '暫停',
    'localFile.position': '播放位置',
    'localFile.mix': '混音',
    'localFile.music': '伴奏',
    'localFile.offset': '人聲對齊',
    'localFile.offsetEarlier': '提前 {ms} ms',
    'localFile.offsetLater': '延後 {ms} ms',
    'localFile.latency': '已自動補償裝置延遲 {ms} ms。',
    'localFile.needsMic': '拿 Mic 後才能播放。',
    'localFile.roomSongPaused': '房間的歌開始播放，已暫停。',
    'localFile.playFailed': '這個檔案無法播放。',
    'localFile.blockedSong': '先暫停 YouTube 歌曲。',
    'localFile.blockedDuet': '副 Mic 在場時不能用。',
  },
});

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

function observingAnotherPhone() {
  return !localFileMix.active && roomLocalFile !== null
    && roomMicOwnerId !== null && roomMicOwnerId !== window.relayParticipantId;
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
  const owner = localFileMix.active;
  const observer = observingAnotherPhone();
  panel.hidden = !owner && !observer;
  songStage.dataset.localFile = owner || observer ? 'on' : 'off';
  document.body.dataset.localFile = owner ? 'on' : 'off';
  if (owner) renderOwner();
  else if (observer) renderObserver();
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
