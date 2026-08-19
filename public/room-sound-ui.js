import { roomSoundPresentation } from './room-sound-presentation.js';

const root = document.querySelector('.local-sound-control');
const title = document.querySelector('#local-listen-label');
const scope = root?.querySelector('.adjust-group-heading > span:not(#local-listen-label)');
const volumeLabel = root?.querySelector('.adjust-row-heading strong');
const toggle = document.querySelector('#listen-toggle');
const gain = document.querySelector('#listen-gain');
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

function roomSoundLabel() {
  return localCopy('Room sound', '房間聲音');
}

function roomSoundVolumeLabel() {
  return localCopy('Room sound volume', '房間聲音音量');
}

function roomSoundToggleLabel(muted) {
  return muted
    ? localCopy('Turn on room sound', '開啟房間聲音')
    : localCopy('Mute room sound', '靜音房間聲音');
}

function renderLabels() {
  if (!root || !title || !scope || !volumeLabel) return;
  const label = roomSoundLabel();
  title.textContent = label;
  scope.textContent = localCopy('This device only', '只影響這支裝置');
  volumeLabel.textContent = localCopy('Volume', '音量');
  root.setAttribute('aria-label', label);
  gain?.setAttribute('aria-label', roomSoundVolumeLabel());
}

function compactStatus(state, phase) {
  // Recovery phases are actionable product state. Do not let generic muted
  // copy hide a failed local audio start that needs another user gesture.
  if (phase === 'retry' || phase === 'start-failed') return localCopy('Retry', '重試');
  if (state === 'mic-muted') return localCopy('Singing', '唱歌中');
  if (state === 'playback-muted') return localCopy('Backing', '伴奏');
  if (state === 'review-muted') return localCopy('Take', '錄音');
  if (phase === 'reconnecting') return localCopy('Reconnecting', '重連中');
  if (phase === 'connecting') return localCopy('Connecting', '連線中');
  if (phase === 'buffering') return localCopy('Buffering', '緩衝中');
  if (phase === 'first-interaction') return localCopy('Enable', '啟用');
  if (state === 'muted' || state === 'off') return localCopy('Muted', '已靜音');
  return '';
}

function renderState(detail = latestState) {
  if (!root || !toggle || !gain || !gainValue || !stateNote) return;
  if (!detail || typeof detail !== 'object') return;
  latestState = detail;

  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');
  const forcedReason = detail.forcedReason ?? null;
  const forced = Boolean(forcedReason);
  const muted = detail.muted === true;
  const volumePercent = Math.max(0, Math.min(100, Math.round(Number(detail.volumePercent) || 0)));
  const presentation = roomSoundPresentation(detail, chinese());
  const compactNote = compactStatus(state, phase);

  root.dataset.listenState = state;
  root.dataset.listenPhase = phase;
  root.dataset.listenNote = presentation.note ? 'visible' : 'quiet';
  root.dataset.roomSoundState = compactNote ? 'visible' : 'quiet';
  document.body.dataset.listen = state;
  toggle.dataset.state = state;
  toggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
  toggle.setAttribute('aria-label', roomSoundToggleLabel(muted || forced));
  toggle.disabled = forced;
  gain.disabled = forced;
  gainValue.value = `${volumePercent}%`;
  toggle.textContent = muted || forced ? '🔇' : '🔊';
  stateNote.textContent = compactNote;
  if (legacyNote) legacyNote.textContent = '';
}

function setGainInteraction(visible) {
  if (!root) return;
  root.dataset.roomSoundValue = visible ? 'visible' : 'quiet';
}

gain?.addEventListener('pointerdown', () => setGainInteraction(true));
gain?.addEventListener('input', () => setGainInteraction(true));
gain?.addEventListener('pointerup', () => setGainInteraction(false));
gain?.addEventListener('change', () => setGainInteraction(false));
gain?.addEventListener('blur', () => setGainInteraction(false));

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
