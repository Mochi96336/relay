const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const publisherButton = document.querySelector('#start-publisher');
const releaseButton = document.querySelector('#release-mic');
const takeoverPanel = document.querySelector('#mic-takeover');
const takeoverCopy = document.querySelector('#mic-takeover-copy');
const confirmTakeoverButton = document.querySelector('#confirm-takeover');
const cancelTakeoverButton = document.querySelector('#cancel-takeover');

let latestState = window.relayMicActionState ?? null;

function failureCopy(failure, owner) {
  if (!failure) return null;
  if (failure.kind === 'start-failed') {
    const message = failure.message || t('mic.startFailed');
    return t('mic.takeoverKept', { message });
  }
  if (failure.kind === 'owner-changed') {
    const name = failure.ownerNickname || owner?.nickname;
    return name
      ? t('mic.takeoverChangedOwner', { name })
      : t('mic.takeoverChanged');
  }
  return t('mic.takeoverChanged');
}

function render(state = latestState) {
  if (
    !publisherButton || !releaseButton || !takeoverPanel || !takeoverCopy
    || !confirmTakeoverButton || !cancelTakeoverButton
  ) return;
  if (!state || typeof state !== 'object') return;
  latestState = state;

  const owner = state.owner && typeof state.owner === 'object' ? state.owner : null;
  const takeoverOpen = state.takeoverOpen === true;
  const takeoverPending = state.takeoverPending === true;
  const takeoverMode = state.primaryMode === 'takeover';

  releaseButton.hidden = state.releaseVisible !== true;
  releaseButton.textContent = t('mic.release');

  if (takeoverMode) {
    publisherButton.dataset.presenceLabel = 'takeover';
    publisherButton.textContent = t('mic.takeover');
  } else {
    delete publisherButton.dataset.presenceLabel;
    publisherButton.textContent = t('mic.microphone');
  }

  // Confirmation replaces the entry action instead of stacking below it.
  publisherButton.hidden = takeoverOpen;
  takeoverPanel.hidden = !takeoverOpen;
  confirmTakeoverButton.disabled = takeoverPending;
  confirmTakeoverButton.textContent = t('mic.take');
  cancelTakeoverButton.textContent = t('mic.cancel');

  if (!takeoverOpen) {
    takeoverCopy.textContent = '';
    return;
  }

  const failure = failureCopy(state.failure, owner);
  if (failure) {
    takeoverCopy.textContent = failure;
    return;
  }

  if (takeoverPending) {
    takeoverCopy.textContent = t('mic.takeoverPreparing', {
      name: owner?.nickname ?? t('voice.someone'),
    });
    return;
  }

  takeoverCopy.textContent = t('mic.takeoverPrompt', {
    name: owner?.nickname ?? t('voice.someone'),
  });
}

for (const node of [publisherButton, releaseButton, confirmTakeoverButton, cancelTakeoverButton]) {
  node?.removeAttribute('data-i18n');
}

window.addEventListener('relay-mic-action-state', (event) => render(event.detail));
window.addEventListener('relay-locale-changed', () => render(latestState));

render();
window.dispatchEvent(new Event('relay-request-mic-action-state'));
