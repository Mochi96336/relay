import { authorityState } from './authority-freshness.js';

const legacyCalibrateButton = document.querySelector('#calibrate-timing');
const legacyCalibrateStatus = document.querySelector('#calibrate-status');
const legacyFineTuneSurface = document.querySelector('.more-timing');

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;

// Keep the legacy fine-tune DOM available to app.js while removing it from the
// normal product surface. The compatibility command path is intentionally not
// rewritten in this presentation-only repair.
if (legacyFineTuneSurface) {
  legacyFineTuneSurface.hidden = true;
  legacyFineTuneSurface.setAttribute?.('aria-hidden', 'true');
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
 * ProductStatus owns all visible calibration prerequisites. The presenter does
 * not rebuild Song, Robot, timeline, or probe prerequisites from local events.
 * A server-owned blocked reason means only that realignment is unavailable;
 * normal UI does not reinterpret technical reason names as progress.
 *
 * Copy always comes through the shared i18n service. This module no longer has
 * its own locale switch or bilingual fallback table, so a locale change cannot
 * briefly expose a second calibration vocabulary.
 */
function render() {
  if (!calibrateButton) return;

  // The legacy template key belongs only to the hidden command node. Once this
  // clone becomes the visible owner, shared i18n no longer paints it behind the
  // presenter's back.
  calibrateButton.removeAttribute?.('data-i18n');
  setText(calibrateButton, t('timing.realign'));

  const authority = calibrationAuthority();
  const reason = latestAction?.startCalibrationBlockedReason ?? null;
  const running = reason === 'calibration-active' || latestTiming?.state === 'calibrating';
  const owner = selfOwnsServerMic();

  if (commandError) {
    setHidden(!owner);
    setDisabled(true);
    setText(calibrateStatus, owner ? t('timing.unavailable') : '');
    return;
  }

  if (latestProductStatus && (!authority.authorityFresh || !authority.commandChannelFresh)) {
    const relevant = owner || latestAction?.canStartCalibration === true || running;
    setHidden(!relevant);
    setDisabled(true);
    setText(calibrateStatus, relevant ? t('timing.reconnecting') : '');
    return;
  }

  if (running) {
    setHidden(!owner);
    setDisabled(true);
    setText(calibrateStatus, owner ? t('timing.aligning') : '');
    return;
  }

  if (authority.actionable) {
    setHidden(false);
    setDisabled(false);
    setText(calibrateStatus, '');
    return;
  }

  // ProductStatus owns the blocked reason. Normal UI exposes only the product
  // consequence, never source/holder/probe/controller implementation wording.
  setHidden(!owner);
  setDisabled(true);
  setText(calibrateStatus, owner && latestAction ? t('timing.unavailable') : '');
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

window.addEventListener('relay-calibration-command-rejected', () => {
  commandError = true;
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
