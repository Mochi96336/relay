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

/* Keep this control visually product-shaped instead of delegating it to the
   platform emoji font. The icon is deliberately quiet: one speaker body plus
   two sound arcs, or a compact mute cross. currentColor lets #66/#68 own state
   emphasis without the presenter owning visual colors. */
function roomSoundIcon(muted) {
  const signal = muted
    ? '<path d="M15.5 9.5l4 5m0-5l-4 5" />'
    : '<path d="M15 9.5c1.4 1.4 1.4 3.6 0 5" /><path d="M17.7 7.4c2.6 2.6 2.6 6.6 0 9.2" />';
  return `<svg class="room-sound-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10h3l4-3v10l-4-3H5z" />${signal}</svg>`;
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
  // copy hide a failed AudioContext start that needs another user gesture.
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
  const visuallyMuted = muted || forced;

  root.dataset.listenState = state;
  root.dataset.listenPhase = phase;
  root.dataset.listenNote = presentation.note ? 'visible' : 'quiet';
  root.dataset.roomSoundState = compactNote ? 'visible' : 'quiet';
  document.body.dataset.listen = state;
  toggle.dataset.state = state;
  toggle.dataset.icon = visuallyMuted ? 'muted' : 'audible';
  toggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
  toggle.setAttribute('aria-label', roomSoundToggleLabel(visuallyMuted));
  toggle.disabled = forced;
  gain.disabled = forced;
  gainValue.value = `${volumePercent}%`;
  toggle.innerHTML = roomSoundIcon(visuallyMuted);
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
