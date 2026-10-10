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
  renderLabels(latestState);
  renderState(latestState);
}

for (const node of [title, scope, volumeLabel, stateNote, actionNote]) {
  node?.removeAttribute('data-i18n');
}

window.addEventListener('relay-listen-state', (event) => renderState(event.detail));
window.addEventListener('relay-locale-changed', render);

render();
window.dispatchEvent(new Event('relay-request-listen-state'));
