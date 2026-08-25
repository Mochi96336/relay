import './live-i18n.js';
import {
  roomSoundActionNote,
  roomSoundControlPresentation,
  roomSoundPresentation,
  roomSoundStableNote,
} from './room-sound-presentation.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const root = document.querySelector('.local-sound-control');
const title = document.querySelector('#local-listen-label');
const scope = root?.querySelector('.adjust-group-heading > span:not(#local-listen-label)');
const volumeLabel = root?.querySelector('.adjust-row-heading strong');
const toggle = document.querySelector('#listen-toggle');
const gain = document.querySelector('#listen-gain');
const gainValue = document.querySelector('#listen-gain-value');
const stateNote = document.querySelector('#listen-adjust-state');
const actionNote = document.querySelector('#listen-note');

let latestState = window.relayListenState ?? null;

function roomSoundIconMarkup() {
  return '<svg class="room-sound-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10h3l4-3v10l-4-3H5z" /><g data-room-sound-signal="audible"><path d="M15 9.5c1.4 1.4 1.4 3.6 0 5" /><path d="M17.7 7.4c2.6 2.6 2.6 6.6 0 9.2" /></g><g data-room-sound-signal="muted"><path d="M15.5 9.5l4 5m0-5l-4 5" /></g><g data-room-sound-signal="retry"><path d="M19.5 8.5v-3l-2 2" /><path d="M19.4 6.1a5 5 0 1 0 1.2 6.7" /></g></svg>';
}

function installRoomSoundIcon() {
  if (!toggle || toggle.querySelector('.room-sound-icon')) return;
  toggle.textContent = '';
  toggle.insertAdjacentHTML('afterbegin', roomSoundIconMarkup());
}

function localized(key) {
  return key ? t(key) : '';
}

function renderLabels(detail = latestState) {
  if (!root || !title || !scope || !volumeLabel) return;
  const presentation = roomSoundControlPresentation(detail ?? {});
  title.textContent = localized(presentation.labelKey);
  scope.textContent = localized(presentation.scopeKey);
  volumeLabel.textContent = localized(presentation.volumeLabelKey);
  root.setAttribute('aria-label', localized(presentation.labelKey));
  gain?.setAttribute('aria-label', localized(presentation.volumeAriaLabelKey));
}

function renderState(detail = latestState) {
  if (!root || !toggle || !gain || !gainValue || !stateNote) return;
  if (!detail || typeof detail !== 'object') return;
  latestState = detail;

  const state = String(detail.state ?? 'ready');
  const phase = String(detail.phase ?? '');
  const forced = Boolean(detail.forcedReason);
  const volumePercent = Math.max(0, Math.min(100, Math.round(Number(detail.volumePercent) || 0)));
  const presentation = roomSoundPresentation(detail);
  const controlPresentation = roomSoundControlPresentation(detail);
  const stableKey = presentation.noteKey || roomSoundStableNote(detail);
  const transientKey = roomSoundActionNote(detail);

  root.dataset.listenState = state;
  root.dataset.listenPhase = phase;
  document.body.dataset.listen = state;
  toggle.dataset.state = state;
  toggle.dataset.icon = controlPresentation.iconState;
  toggle.setAttribute('aria-pressed', detail.muted === true ? 'true' : 'false');
  toggle.setAttribute('aria-label', localized(controlPresentation.toggleAriaLabelKey));
  if (stableKey) toggle.setAttribute('aria-describedby', 'listen-adjust-state');
  else toggle.removeAttribute('aria-describedby');
  toggle.disabled = forced;
  gain.disabled = forced;
  gainValue.value = `${volumePercent}%`;
  stateNote.textContent = localized(stableKey);
  if (actionNote) actionNote.textContent = localized(transientKey);
}

function render() {
  installRoomSoundIcon();
  renderLabels(latestState);
  renderState(latestState);
}

for (const node of [title, scope, volumeLabel, toggle, stateNote, actionNote]) {
  node?.removeAttribute('data-i18n');
}

window.addEventListener('relay-listen-state', (event) => renderState(event.detail));
window.addEventListener('relay-locale-changed', render);

render();
window.dispatchEvent(new Event('relay-request-listen-state'));
