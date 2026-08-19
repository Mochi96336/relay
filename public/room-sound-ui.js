import { roomSoundPresentation } from './room-sound-presentation.js';
import { roomSoundControlPresentation } from './room-sound-presentation.js';

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

function renderLabels(detail = latestState) {
  if (!root || !title || !scope || !volumeLabel) return;
  const presentation = roomSoundControlPresentation(detail ?? {}, chinese());
  title.textContent = presentation.label;
  scope.textContent = presentation.scope;
  volumeLabel.textContent = presentation.volumeLabel;
  root.setAttribute('aria-label', presentation.label);
  gain?.setAttribute('aria-label', presentation.volumeAriaLabel);
}

function renderState(detail = latestState) {
  if (!root || !toggle || !gain || !gainValue || !stateNote) return;
  if (!detail || typeof detail !== 'object') return;
  latestState = detail;

  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');
  const forced = Boolean(detail.forcedReason);
  const muted = detail.muted === true;
  const volumePercent = Math.max(0, Math.min(100, Math.round(Number(detail.volumePercent) || 0)));
  const presentation = roomSoundPresentation(detail, chinese());
  const controlPresentation = roomSoundControlPresentation(detail, chinese());

  root.dataset.listenState = state;
  root.dataset.listenPhase = phase;
  root.dataset.listenNote = presentation.note ? 'visible' : 'quiet';
  root.dataset.roomSoundState = controlPresentation.compact ? 'visible' : 'quiet';
  document.body.dataset.listen = state;
  toggle.dataset.state = state;
  toggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
  toggle.setAttribute('aria-label', controlPresentation.toggleAriaLabel);
  toggle.disabled = forced;
  gain.disabled = forced;
  gainValue.value = `${volumePercent}%`;
  toggle.textContent = muted || forced ? '🔇' : '🔊';
  stateNote.textContent = controlPresentation.compact;
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
  renderLabels(latestState);
  renderState(latestState);
}

for (const node of [title, scope, volumeLabel, toggle, stateNote, legacyNote]) {
  node?.removeAttribute('data-i18n');
}

window.addEventListener('relay-listen-state', (event) => renderState(event.detail));
window.addEventListener('relay-locale-changed', render);

render();
window.dispatchEvent(new Event('relay-request-listen-state'));
