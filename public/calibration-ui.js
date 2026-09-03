import { authorityState } from './authority-freshness.js';
import { sendPreflightCalibrationCommand } from './calibration-command.js';
import { formatTimingValueMs } from './timing-value.js';
import './timing-authority.js';
import './calibration-system-details.js';

let initialized = false;

function initialize() {
  if (initialized) return;
  initialized = true;

  const legacyCalibrateButton = document.querySelector('#calibrate-timing');
  const legacyCalibrateStatus = document.querySelector('#calibrate-status');
  const legacyFineTuneSurface = document.querySelector('.more-timing');
  const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;

  // Compatibility DOM remains available to app.js and the wire protocol, but
  // manual fine tune is no longer a normal Live product control.
  if (legacyFineTuneSurface) {
    legacyFineTuneSurface.hidden = true;
    legacyFineTuneSurface.setAttribute?.('aria-hidden', 'true');
  }

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

  function installTimingButtonSurface(button) {
    if (
      !button
      || typeof document.createElement !== 'function'
      || typeof button.replaceChildren !== 'function'
    ) {
      return { label: button, value: null };
    }

    const label = document.createElement('span');
    label.className = 'calibrate-timing-label';

    const value = document.createElement('span');
    value.id = 'timing-active-value';
    value.className = 'calibrate-timing-value';
    value.setAttribute?.('aria-live', 'polite');
    value.textContent = '—';

    // The existing .more-action flex row already owns spacing. Keep the
    // authoritative mixer value on the action it qualifies instead of adding
    // a separate pseudo-setting above it.
    button.replaceChildren(label, value);
    return { label, value };
  }

  const ownership = takeVisibleOwnership(legacyCalibrateButton, legacyCalibrateStatus);
  const calibrateButton = ownership.button;
  const calibrateStatus = ownership.status;
  const commandTarget = ownership.commandTarget;
  const timingSurface = installTimingButtonSurface(calibrateButton);
  const calibrateLabel = timingSurface.label;
  const activeTimingValue = timingSurface.value;

  let latestProductStatus = window.relayProductAuthority?.lastKnownSnapshot ?? null;
  let latestAction = latestProductStatus?.actions ?? null;
  let latestTiming = latestProductStatus?.timing ?? null;
  let productAuthority = window.relayProductAuthority ?? authorityState({
    lastKnownSnapshot: latestProductStatus,
  });
  let timingAuthority = window.relayTimingAuthority ?? {
    authorityFresh: false,
    valueMs: null,
  };
  let commandAuthority = window.relayCommandAuthority ?? authorityState();
  let commandError = null;
  let preflightCommandPending = false;

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function setHidden(value) {
    if (calibrateButton && calibrateButton.hidden !== value) calibrateButton.hidden = value;
  }

  function setDisabled(value) {
    if (calibrateButton && calibrateButton.disabled !== value) calibrateButton.disabled = value;
  }

  function timingIsProductRelevant() {
    return latestProductStatus?.timing?.state !== undefined
      && latestProductStatus.timing.state !== 'idle';
  }

  function renderTimingAuthority() {
    // A running AudioSession is not enough to make an alignment value meaningful.
    // Voice-only and paused rooms intentionally render no number even if the
    // mixer happens to carry a technical 0 ms read-head value.
    const formatted = timingIsProductRelevant() && timingAuthority?.authorityFresh === true
      ? formatTimingValueMs(timingAuthority.valueMs)
      : null;
    setText(activeTimingValue, formatted ?? '—');
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

  function needsPreflightCommandPath() {
    return latestAction?.startCalibrationMode === 'boot-probe'
      && latestProductStatus?.room?.song?.videoId == null;
  }

  /**
   * ProductStatus owns visible calibration lifecycle/action policy. The timing
   * number is independent: it is painted only from the server-applied mixer
   * read head, never from candidates, Robot observations, or local seek state.
   */
  function render() {
    renderTimingAuthority();
    if (!calibrateButton) return;

    calibrateButton.removeAttribute?.('data-i18n');
    setText(calibrateLabel, t('timing.realign'));

    const authority = calibrationAuthority();
    const reason = latestAction?.startCalibrationBlockedReason ?? null;
    const running = preflightCommandPending
      || reason === 'calibration-active'
      || latestTiming?.state === 'calibrating';
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
    if (latestAction?.startCalibrationBlockedReason === 'calibration-active') {
      preflightCommandPending = false;
    }
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

  window.addEventListener('relay-timing-authority', (event) => {
    timingAuthority = event.detail ?? { authorityFresh: false, valueMs: null };
    render();
  });

  window.addEventListener('relay-command-authority', (event) => {
    commandAuthority = event.detail ?? authorityState();
    render();
  });

  window.addEventListener('relay-calibration-command-rejected', () => {
    commandError = true;
    preflightCommandPending = false;
    render();
  });

  window.addEventListener('relay-locale-changed', render);

  calibrateButton?.addEventListener?.('click', () => {
    if (!commandTarget || !calibrationAuthority().actionable) return;

    // app.js still owns the historical publisher command listener, but that
    // listener incorrectly requires a Song. Use a narrow authenticated command
    // socket only for the no-Song Robot preflight case; all normal commands keep
    // flowing through the established publisher transport.
    if (needsPreflightCommandPath()) {
      preflightCommandPending = true;
      render();
      void sendPreflightCalibrationCommand().catch(() => {
        commandError = true;
      }).finally(() => {
        preflightCommandPending = false;
        render();
      });
      return;
    }

    commandTarget.dispatchEvent(new Event('click', { cancelable: true }));
  });

  setHidden(true);
  setDisabled(true);
  render();
}

// live-ia may import this module at DOMContentLoaded, while app.js is a later
// module script and still needs to capture/install the authenticated command
// listener on the legacy node. Window load is the simple deterministic fence:
// only after it fires may the presenter detach that node and become visible.
if (document.readyState === 'complete' || typeof document.readyState !== 'string') {
  initialize();
} else {
  window.addEventListener('load', initialize, { once: true });
}
