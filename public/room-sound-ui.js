import {
  roomSoundActionNote,
  roomSoundPresentation,
  roomSoundStableNote,
} from './room-sound-presentation.js';

const root = document.querySelector('.local-sound-control');
const title = document.querySelector('#local-listen-label');
const scope = root?.querySelector('.adjust-group-heading > span:not(#local-listen-label)');
const volumeLabel = root?.querySelector('.adjust-row-heading strong');
const toggle = document.querySelector('#listen-toggle');
const gainValue = document.querySelector('#listen-gain-value');
const stateNote = document.querySelector('#listen-adjust-state');
const actionNote = document.querySelector('#listen-note');

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

function renderState(detail = latestState) {
  if (!root || !toggle || !gainValue || !stateNote || !actionNote) return;
  if (!detail || typeof detail !== 'object') return;
  latestState = detail;

  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');
  const forcedReason = detail.forcedReason ?? null;
  const muted = detail.muted === true;
  const volumePercent = Math.max(0, Math.min(100, Math.round(Number(detail.volumePercent) || 0)));
  const isChinese = chinese();
  const presentation = roomSoundPresentation(detail, isChinese);
  const stableNote = roomSoundStableNote(detail, isChinese);
  const transientNote = roomSoundActionNote(detail, isChinese);

  root.dataset.listenState = state;
  root.dataset.listenPhase = phase;
  root.dataset.listenNote = stableNote ? 'visible' : 'quiet';
  document.body.dataset.listen = state;
  toggle.dataset.state = state;
  toggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
  toggle.disabled = Boolean(forcedReason);
  gainValue.value = `${volumePercent}%`;
  toggle.textContent = presentation.toggle;
  stateNote.textContent = stableNote;
  actionNote.textContent = transientNote;
}

function render() {
  renderLabels();
  renderState(latestState);
}

for (const node of [title, scope, volumeLabel, toggle, stateNote, actionNote]) {
  node?.removeAttribute('data-i18n');
}

window.addEventListener('relay-listen-state', (event) => renderState(event.detail));
window.addEventListener('relay-locale-changed', render);

render();
window.dispatchEvent(new Event('relay-request-listen-state'));
