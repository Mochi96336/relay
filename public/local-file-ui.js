import { localFileMix } from './local-file-mix.js';

window.relayI18n?.registerMessages({
  en: {
    'localFile.open': 'Open local audio file',
    'localFile.label': 'Local file',
    'localFile.close': 'Close',
    'localFile.play': 'Play',
    'localFile.pause': 'Pause',
    'localFile.position': 'Position',
    'localFile.mix': 'Mix',
    'localFile.music': 'Song level',
    'localFile.offset': 'Voice timing',
    'localFile.offsetEarlier': '{ms} ms earlier',
    'localFile.offsetLater': '{ms} ms later',
    'localFile.latency': 'Measured device delay {ms} ms is already compensated. Move Voice timing if your voice still sounds late or early on Listen.',
    'localFile.needsMic': 'Take Mic to play. The song and your voice are mixed on this phone and sent as one.',
    'localFile.roomSongPlaying': 'The room YouTube song is playing. Pause it to play your file.',
    'localFile.roomSongPaused': 'Paused: the room YouTube song started.',
    'localFile.playFailed': 'This file could not be played.',
    'localFile.live': 'Listen hears the song and your voice as mixed here. Only you control it.',
  },
  'zh-Hant': {
    'localFile.open': '打開本機音檔',
    'localFile.label': '本機音檔',
    'localFile.close': '關閉',
    'localFile.play': '播放',
    'localFile.pause': '暫停',
    'localFile.position': '播放位置',
    'localFile.mix': '混音',
    'localFile.music': '伴奏音量',
    'localFile.offset': '人聲對齊',
    'localFile.offsetEarlier': '提前 {ms} ms',
    'localFile.offsetLater': '延後 {ms} ms',
    'localFile.latency': '已自動補償裝置延遲 {ms} ms。Listen 聽起來人聲還是太晚或太早，就調「人聲對齊」。',
    'localFile.needsMic': '拿 Mic 後才能播放：歌和人聲在這支手機上混好再一起送出。',
    'localFile.roomSongPlaying': '房間的 YouTube 歌正在播放，先暫停它才能播本機音檔。',
    'localFile.roomSongPaused': '已暫停：房間的 YouTube 歌開始播放了。',
    'localFile.playFailed': '這個檔案無法播放。',
    'localFile.live': 'Listen 聽到的是這裡混好的歌和人聲；只有你能控制。',
  },
});

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const $ = selector => document.querySelector(selector);

const moreMenu = $('#room-more');
const openButton = $('#open-local-file');
const fileInput = $('#local-file-input');
const panel = $('#local-file-panel');
const title = $('#local-file-title');
const closeButton = $('#local-file-close');
const playButton = $('#local-file-play');
const seek = $('#local-file-seek');
const time = $('#local-file-time');
const note = $('#local-file-note');
const music = $('#local-file-music');
const musicValue = $('#local-file-music-value');
const offset = $('#local-file-offset');
const offsetValue = $('#local-file-offset-value');
const latency = $('#local-file-latency');
const micGain = $('#mic-gain');

let micActive = window.relayActiveRole === 'publisher';
let roomSongPlaying = false;
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

function render() {
  const active = localFileMix.active;
  panel.hidden = !active;
  document.body.dataset.localFile = active ? 'on' : 'off';
  if (!active) return;

  title.textContent = localFileMix.title ?? '';
  const playing = localFileMix.playing;
  playButton.textContent = t(playing ? 'localFile.pause' : 'localFile.play');
  playButton.disabled = !playing && (!micActive || !localFileMix.attached || roomSongPlaying);

  const duration = localFileMix.duration;
  seek.max = String(duration ?? 0);
  seek.disabled = duration === null;
  if (!seeking) seek.value = String(localFileMix.currentTime);
  time.textContent = `${clock(localFileMix.currentTime)} / ${clock(duration)}`;

  let message = transientNote;
  if (!message) {
    if (!micActive || !localFileMix.attached) message = t('localFile.needsMic');
    else if (roomSongPlaying && !playing) message = t('localFile.roomSongPlaying');
    else if (playing) message = t('localFile.live');
  }
  note.textContent = message ?? '';

  music.value = String(Math.round(localFileMix.musicLevel * 100));
  musicValue.value = `${music.value}%`;
  offset.value = String(localFileMix.offsetMs);
  offsetValue.value = offsetLabel(localFileMix.offsetMs);
  latency.textContent = t('localFile.latency', { ms: localFileMix.roundTripMs });
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
