function ensureStyles() {
  if (document.querySelector('link[data-relay-room-sound-ui]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/room-sound-ui.css';
  link.dataset.relayRoomSoundUi = 'true';
  document.head.append(link);
}

const root = document.querySelector('.local-sound-control');
const title = document.querySelector('#local-listen-label');
const scope = root?.querySelector('.adjust-group-heading > span:not(#local-listen-label)');
const volumeLabel = root?.querySelector('.adjust-row-heading strong');
const toggle = document.querySelector('#listen-toggle');
const stateNote = document.querySelector('#listen-adjust-state');

function chinese() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant';
}

function localCopy(english, traditionalChinese) {
  return chinese() ? traditionalChinese : english;
}

function renderLabels() {
  if (!root || !title || !scope || !volumeLabel) return;
  // These labels describe the product boundary, not an implementation module.
  // listen.js still owns every audible/muted state and the actual WebAudio path.
  title.textContent = localCopy('Room sound', '房間聲音');
  scope.textContent = localCopy('This device only', '只影響這支裝置');
  volumeLabel.textContent = localCopy('Volume', '音量');
}

function renderState() {
  if (!toggle || !stateNote) return;
  const state = document.body.dataset.listen;

  if (state === 'muted') {
    toggle.textContent = localCopy('Turn on', '開啟');
    stateNote.textContent = localCopy('Room sound is muted.', '房間聲音已靜音');
    return;
  }

  if (state === 'mic-muted') {
    toggle.textContent = localCopy('Paused', '暫停中');
    stateNote.textContent = localCopy(
      'Room sound pauses while you sing.',
      '唱歌時暫停房間聲音',
    );
    return;
  }

  if (state === 'playback-muted') {
    toggle.textContent = localCopy('Paused', '暫停中');
    stateNote.textContent = localCopy(
      'This device is playing the backing track.',
      '這支裝置正在播放伴奏',
    );
    return;
  }

  if (state === 'audible' || state === 'ready') {
    toggle.textContent = localCopy('Mute', '靜音');
  }
}

function render() {
  renderLabels();
  renderState();
}

for (const node of [title, scope, volumeLabel]) {
  node?.removeAttribute('data-i18n');
}

if (root) {
  ensureStyles();
  const listenStateObserver = new MutationObserver(() => renderState());
  listenStateObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-listen'],
  });
}

render();
// listen.js also localizes its button/status copy. Defer our product projection
// until synchronous locale listeners have finished so the presentation layer
// remains the final wording without owning any audio state.
window.addEventListener('relay-locale-changed', () => queueMicrotask(render));
