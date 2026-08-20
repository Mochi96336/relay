const legacyCalibrateButton = document.querySelector('#calibrate-timing');
const legacyCalibrateStatus = document.querySelector('#calibrate-status');

function copy(key) {
  const zh = window.relayI18n?.getLocale?.() === 'zh-Hant';
  if (key === 'realign') return zh ? '重新對齊' : 'Realign';
  if (key === 'aligning') return zh ? '對齊中…' : 'Aligning…';
  if (key === 'preparing-paths') return zh ? '正在準備聲音路徑…' : 'Preparing audio paths…';
  return '';
}

/*
 * app.js historically captured these nodes before ProductStatus had a semantic
 * calibration action. Keep that legacy node only as the command transport
 * endpoint, then replace the painted nodes so there is exactly one visible
 * presenter. app.js may continue updating its detached compatibility nodes;
 * those writes can no longer race with product presentation.
 */
function takeVisibleOwnership(button, status) {
  if (
    !button || !status
    || typeof button.cloneNode !== 'function'
    || typeof status.cloneNode !== 'function'
    || typeof button.replaceWith !== 'function'
    || typeof status.replaceWith !== 'function'
  ) {
    return { button, status, commandTarget: null };
  }

  const visibleButton = button.cloneNode(true);
  const visibleStatus = status.cloneNode(true);

  button.id = 'calibrate-timing-command';
  button.hidden = true;
  button.disabled = true;
  button.setAttribute?.('aria-hidden', 'true');
  button.tabIndex = -1;

  status.id = 'calibrate-status-command';
  status.hidden = true;
  status.setAttribute?.('aria-hidden', 'true');

  button.replaceWith(visibleButton);
  status.replaceWith(visibleStatus);

  return { button: visibleButton, status: visibleStatus, commandTarget: button };
}

const ownership = takeVisibleOwnership(legacyCalibrateButton, legacyCalibrateStatus);
const calibrateButton = ownership.button;
const calibrateStatus = ownership.status;
const commandTarget = ownership.commandTarget;

let latestAction = null;
let latestTiming = null;
let localMicOwner = document.body?.dataset?.selfMic === 'live';

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setHidden(value) {
  if (calibrateButton && calibrateButton.hidden !== value) calibrateButton.hidden = value;
}

function setDisabled(value) {
  if (calibrateButton && calibrateButton.disabled !== value) calibrateButton.disabled = value;
}

/**
 * ProductStatus owns all visible calibration prerequisites in both modes.
 * Content correlation may require Song playback; Robot boot-probe deliberately
 * does not. The UI never reconstructs those rules from Song/timeline DOM state.
 */
function render() {
  if (!calibrateButton) return;

  calibrateButton.removeAttribute?.('data-i18n');
  setText(calibrateButton, copy('realign'));

  const mode = latestAction?.startCalibrationMode ?? null;
  const reason = latestAction?.startCalibrationBlockedReason ?? null;
  const running = reason === 'calibration-active' || latestTiming?.state === 'calibrating';
  const bootProbePreparing = mode === 'boot-probe'
    && (reason === 'sources-not-connected' || reason === 'sources-not-streaming');

  if (running) {
    const show = localMicOwner;
    setHidden(!show);
    setDisabled(true);
    setText(calibrateButton, copy('aligning'));
    setText(calibrateStatus, show ? copy('aligning') : '');
    return;
  }

  if (bootProbePreparing) {
    setHidden(true);
    setDisabled(true);
    setText(calibrateStatus, localMicOwner ? copy('preparing-paths') : '');
    return;
  }

  if (latestAction?.canStartCalibration === true && localMicOwner) {
    setHidden(false);
    setDisabled(false);
    setText(calibrateStatus, '');
    return;
  }

  // Unavailable recovery actions do not occupy a disabled row. ProductStatus
  // already owns the blocked reason; normal UI does not revive Song-era guesses
  // such as "No song to align" or "Waiting for room state".
  setHidden(true);
  setDisabled(true);
  setText(calibrateStatus, '');
}

window.addEventListener('relay-product-status', (event) => {
  latestAction = event.detail?.actions ?? null;
  latestTiming = event.detail?.timing ?? null;
  render();
});

window.addEventListener('relay-microphone-local-state', (event) => {
  localMicOwner = event.detail?.active === true;
  render();
});

window.addEventListener('relay-locale-changed', render);

// The visible ProductStatus-owned action forwards the real user click into the
// already-installed command transport listener. No command result is faked:
// app.js still sends start-timing-calibration through its authenticated socket,
// and the next server ProductStatus determines the rendered result.
calibrateButton?.addEventListener?.('click', () => {
  if (!commandTarget || calibrateButton.disabled) return;
  commandTarget.dispatchEvent(new Event('click', { cancelable: true }));
});

// Do not paint the template's legacy Recalibrate fallback before authoritative
// ProductStatus arrives.
setHidden(true);
setDisabled(true);
render();
