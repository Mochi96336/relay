import { authorityState } from './authority-freshness.js';
import { formatTimingValueMs } from './timing-value.js';
import './timing-authority.js';

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

  function installTimingSurface(button) {
    const existing = document.querySelector('#timing-active-value');
    if (existing) {
      return {
        label: document.querySelector('#timing-active-label'),
        value: existing,
      };
    }
    if (!button || typeof document.createElement !== 'function') {
      return { label: null, value: null };
    }

    const row = document.createElement('div');
    row.className = 'more-timing-authority';
    row.setAttribute?.('aria-live', 'polite');

    const label = document.createElement('span');
    label.id = 'timing-active-label';

    const value = document.createElement('output');
    value.id = 'timing-active-value';
    value.textContent = '—';

    row.append?.(label, value);
    button.insertAdjacentElement?.('beforebegin', row);
    return { label, value };
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

  const timingSurface = installTimingSurface(legacyCalibrateButton);
  const activeTimingLabel = timingSurface.label;
  const activeTimingValue = timingSurface.value;
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
  let timingAuthority = window.relayTimingAuthority ?? {
    authorityFresh: false,
    valueMs: null,
  };
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

  function renderTimingAuthority() {
    setText(activeTimingLabel, t('timing.label'));
    const formatted = timingAuthority?.authorityFresh === true
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

  /**
   * ProductStatus owns visible calibration lifecycle/action policy. The timing
   * number is independent: it is painted only from the server-applied mixer
   * read head, never from candidates, Robot observations, or local seek state.
   */
  function render() {
    renderTimingAuthority();
    if (!calibrateButton) return;

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
    render();
  });

  window.addEventListener('relay-locale-changed', render);

  calibrateButton?.addEventListener?.('click', () => {
    if (!commandTarget || !calibrationAuthority().actionable) return;
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
