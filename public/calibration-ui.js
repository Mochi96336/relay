import { authorityState } from './authority-freshness.js';

const legacyCalibrateButton = document.querySelector('#calibrate-timing');
const legacyCalibrateStatus = document.querySelector('#calibrate-status');

function copy(key) {
  const zh = window.relayI18n?.getLocale?.() === 'zh-Hant';
  if (key === 'realign') return zh ? '重新對齊' : 'Realign';
  if (key === 'aligning') return zh ? '對齊中…' : 'Aligning…';
  if (key === 'preparing-paths') return zh ? '正在準備聲音路徑…' : 'Preparing audio paths…';
  if (key === 'reconnecting') return zh ? '重新連線中…' : 'Reconnecting…';
  if (key === 'finish-take') return zh ? '請先完成目前的錄音' : 'Finish the current Take before calibrating.';
  if (key === 'unavailable') return zh ? '目前無法校準' : 'Calibration is unavailable.';
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

let latestProductStatus = window.relayProductAuthority?.lastKnownSnapshot ?? null;
let latestAction = latestProductStatus?.actions ?? null;
let latestTiming = latestProductStatus?.timing ?? null;
let productAuthority = window.relayProductAuthority ?? authorityState({
  lastKnownSnapshot: latestProductStatus,
});
let commandAuthority = window.relayCommandAuthority ?? authorityState();
let commandError = null;

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setHidden(value) {
  if (calibrateButton && calibrateButton.hidden !== value) calibrateButton.hidden = value;
}

function setDisabled(value) {
  if (calibrateButton && calibrateButton.disabled !== value) calibrateButton.disabled = value;
}

function selfOwnsServerMic(status = latestProductStatus) {
  return Boolean(
    status?.room?.mic?.ownerId
    && typeof window.relayParticipantId === 'string'
    && status.room.mic.ownerId === window.relayParticipantId,
  );
}

function calibrationAuthority() {
  return authorityState({
    authorityFresh: productAuthority?.authorityFresh === true,
    lastKnownSnapshot: latestProductStatus,
    commandChannelFresh: commandAuthority?.commandChannelFresh === true,
    authorized: selfOwnsServerMic(),
    serverAllowed: latestAction?.canStartCalibration === true,
  });
}

/**
 * ProductStatus owns all visible calibration prerequisites in both modes.
 * Content correlation may require Song playback; Robot boot-probe deliberately
 * does not. Local capture state is not server authorization: the last server
 * snapshot may stay visible while stale, but it never makes this action live.
 */
function render() {
  if (!calibrateButton) return;

  calibrateButton.removeAttribute?.('data-i18n');
  setText(calibrateButton, copy('realign'));

  const authority = calibrationAuthority();
  const mode = latestAction?.startCalibrationMode ?? null;
  const reason = latestAction?.startCalibrationBlockedReason ?? null;
  const running = reason === 'calibration-active' || latestTiming?.state === 'calibrating';
  const bootProbePreparing = mode === 'boot-probe'
    && (reason === 'sources-not-connected' || reason === 'sources-not-streaming');
  const owner = selfOwnsServerMic();

  if (commandError) {
    setHidden(!owner);
    setDisabled(true);
    setText(calibrateStatus, commandError);
    return;
  }

  if (latestProductStatus && (!authority.authorityFresh || !authority.commandChannelFresh)) {
    const relevant = owner || latestAction?.canStartCalibration === true || running;
    setHidden(!relevant);
    setDisabled(true);
    setText(calibrateStatus, relevant ? copy('reconnecting') : '');
    return;
  }

  if (running) {
    setHidden(!owner);
    setDisabled(true);
    setText(calibrateButton, copy('aligning'));
    setText(calibrateStatus, owner ? copy('aligning') : '');
    return;
  }

  if (bootProbePreparing) {
    setHidden(true);
    setDisabled(true);
    setText(calibrateStatus, owner ? copy('preparing-paths') : '');
    return;
  }

  if (authority.actionable) {
    setHidden(false);
    setDisabled(false);
    setText(calibrateStatus, '');
    return;
  }

  // Unavailable recovery actions do not occupy a disabled row. ProductStatus
  // already owns the blocked reason; normal UI does not revive Song-era guesses
  // such as "No song to align" or local Mic ownership as server truth.
  setHidden(true);
  setDisabled(true);
  setText(calibrateStatus, '');
}

window.addEventListener('relay-product-status', (event) => {
  latestProductStatus = event.detail ?? null;
  latestAction = latestProductStatus?.actions ?? null;
  latestTiming = latestProductStatus?.timing ?? null;
  productAuthority = authorityState({
    authorityFresh: true,
    lastKnownSnapshot: latestProductStatus,
  });
  commandError = null;
  render();
});

window.addEventListener('relay-product-authority', (event) => {
  productAuthority = event.detail ?? authorityState({ lastKnownSnapshot: latestProductStatus });
  if (productAuthority.lastKnownSnapshot) {
    latestProductStatus = productAuthority.lastKnownSnapshot;
    latestAction = latestProductStatus?.actions ?? null;
    latestTiming = latestProductStatus?.timing ?? null;
  }
  render();
});

window.addEventListener('relay-command-authority', (event) => {
  commandAuthority = event.detail ?? authorityState();
  render();
});

window.addEventListener('relay-calibration-command-rejected', (event) => {
  const reason = event.detail?.reason;
  commandError = reason === 'take-active'
    ? copy('finish-take')
    : `${copy('unavailable')} ${reason ?? ''}`.trim();
  render();
});

window.addEventListener('relay-locale-changed', render);

// The visible ProductStatus-owned action forwards the real user click into the
// already-installed command transport listener. No command result is faked:
// app.js still sends start-timing-calibration through its authenticated socket,
// and the next server ProductStatus determines the rendered result.
calibrateButton?.addEventListener?.('click', () => {
  if (!commandTarget || !calibrationAuthority().actionable) return;
  commandTarget.dispatchEvent(new Event('click', { cancelable: true }));
});

// Do not paint the template's legacy Recalibrate fallback before authoritative
// ProductStatus arrives.
setHidden(true);
setDisabled(true);
render();
