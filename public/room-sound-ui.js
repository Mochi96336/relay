const root = document.querySelector('.local-sound-control');
const title = document.querySelector('#local-listen-label');
const scope = root?.querySelector('.adjust-group-heading > span:not(#local-listen-label)');
const volumeLabel = root?.querySelector('.adjust-row-heading strong');
const toggle = document.querySelector('#listen-toggle');
const gainValue = document.querySelector('#listen-gain-value');
const stateNote = document.querySelector('#listen-adjust-state');
const legacyNote = document.querySelector('#listen-note');

let latestState = window.relayListenState ?? null;

function chinese() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant';
}

function localCopy(english, traditionalChinese) {
  return chinese() ? traditionalChinese : english;
}

function renderLabels() {
  if (!root || !title || !scope || !volumeLabel) return;
  title.textContent = localCopy('Room sound', '房間聲音');
  scope.textContent = localCopy('This device only', '只影響這支裝置');
  volumeLabel.textContent = localCopy('Volume', '音量');
}

function readyCopy(phase) {
  if (phase === 'reconnecting' || phase === 'connecting') {
    return localCopy('Connecting room sound…', '正在連接房間聲音…');
  }
  if (phase === 'buffering') {
    return localCopy('Buffering room sound…', '房間聲音緩衝中…');
  }
  if (phase === 'retry' || phase === 'start-failed') {
    return localCopy('Tap again to start room sound.', '再點一下以啟用房間聲音');
  }
  return localCopy('Tap once to enable room sound.', '點一下以啟用房間聲音');
}

function renderState(detail = latestState) {
  if (!root || !toggle || !gainValue || !stateNote) return;
  if (!detail || typeof detail !== 'object') return;
  latestState = detail;

  const state = String(detail.state ?? 'ready');
  const forcedReason = detail.forcedReason ?? null;
  const muted = detail.muted === true;
  const volumePercent = Math.max(0, Math.min(100, Math.round(Number(detail.volumePercent) || 0)));

  root.dataset.listenState = state;
  document.body.dataset.listen = state;
  toggle.dataset.state = state;
  toggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
  toggle.disabled = Boolean(forcedReason);
  gainValue.value = `${volumePercent}%`;
  if (legacyNote) legacyNote.textContent = '';

  if (state === 'muted') {
    toggle.textContent = localCopy('Turn on', '開啟');
    stateNote.textContent = localCopy('Room sound is muted.', '房間聲音已靜音');
    return;
  }

  if (state === 'mic-muted') {
    toggle.textContent = localCopy('Paused', '暫停中');
    stateNote.textContent = localCopy('Paused while you sing.', '唱歌時暫停');
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

  if (state === 'review-muted') {
    toggle.textContent = localCopy('Paused', '暫停中');
    stateNote.textContent = localCopy('Take playback is playing.', '正在播放錄音');
    return;
  }

  toggle.textContent = localCopy('Mute', '靜音');
  stateNote.textContent = state === 'ready' ? readyCopy(detail.phase) : '';
}

function render() {
  renderLabels();
  renderState(latestState);
}

for (const node of [title, scope, volumeLabel, toggle, stateNote, legacyNote]) {
  node?.removeAttribute('data-i18n');
}

window.addEventListener('relay-listen-state', (event) => renderState(event.detail));
window.addEventListener('relay-locale-changed', render);

render();
window.dispatchEvent(new Event('relay-request-listen-state'));
