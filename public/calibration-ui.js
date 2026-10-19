import { authorityState } from './authority-freshness.js';
import { sendPreflightCalibrationCommand } from './calibration-command.js';
import { formatTimingValueMs } from './timing-value.js';
import './timing-authority.js';
import './calibration-system-details.js';

let initialized = false;

function initialize() {
  if (initialized) return;
  initialized = true;

  const calibrateButton = document.querySelector('#calibrate-timing');
  const calibrateStatus = document.querySelector('#calibrate-status');
  const calibrateLabel = calibrateButton?.querySelector?.('.calibrate-timing-label') ?? null;
  // The authoritative mixer value qualifies the action it belongs to.
  const activeTimingValue = document.querySelector('#timing-active-value');
  const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;

  let latestProductStatus = window.relayProductAuthority?.lastKnownSnapshot ?? null;
  let latestAction = latestProductStatus?.actions ?? null;
  let productAuthority = window.relayProductAuthority ?? authorityState({
    lastKnownSnapshot: latestProductStatus,
  });
  let timingAuthority = window.relayTimingAuthority ?? {
    authorityFresh: false,
    valueMs: null,
  };
  let commandAuthority = window.relayCommandAuthority ?? authorityState();
  let commandError = null;
  // B pressed Realign and the room has not yet said the test tone started.
  let secondMicRequestPending = false;
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

  function renderTimingAuthority() {
    // This is the one user-facing timing value: the mixer read head actually in
    // force after network estimate, calibration, fine tune, and buffer clamping.
    // Product/Song lifecycle only controls whether recalibration is actionable;
    // it must not hide a fresh value the user is currently hearing.
    const formatted = timingAuthority?.authorityFresh === true
      ? formatTimingValueMs(timingAuthority.valueMs)
      : null;
    setText(activeTimingValue, formatted ?? '—');
  }

  /** This page is the joined second Mic: Realign is B's own test tone. */
  function selfIsSecondMic(status = latestProductStatus) {
    const duet = status?.room?.duet;
    return Boolean(duet?.secondaryId && duet.secondaryId === window.relayParticipantId
      && !selfOwnsServerMic(status));
  }

  /**
   * The second Mic's Realign: B's value is where B sits in the room output, in
   * the same coordinates as the main Mic's, and pressing it replays only B's
   * own three notes. The main Mic's alignment is not B's to restart.
   */
  function renderSecondMic() {
    const duet = latestProductStatus.room.duet;
    setText(activeTimingValue, formatTimingValueMs(duet.lagMs) ?? '—');
    setHidden(false);
    const busy = duet.realigning === true || secondMicRequestPending;
    setDisabled(busy || productAuthority?.authorityFresh !== true);
    setText(calibrateStatus, busy ? t('timing.aligning') : '');
  }

  function selfOwnsServerMic(status = latestProductStatus) {
    return Boolean(
      status?.room?.mic?.ownerId
      && typeof window.relayParticipantId === 'string'
      && status.room.mic.ownerId === window.relayParticipantId,
    );
  }

  function needsPreflightCommandPath() {
    return latestAction?.startCalibrationMode === 'boot-probe'
      && latestProductStatus?.room?.song?.videoId == null;
  }

  /**
   * Says why the action is refused, using the reason the server already
   * computed. Falling back to one "unavailable" line told the user it would
   * not work while the payload said exactly why, and each of these has a
   * different recovery.
   */
  /**
   * Says why Realign shows "—" instead of a value. A bare dash beside an
   * enabled Realign read as broken while a song the room had not registered
   * was playing on the page.
   */
  function pendingValueText() {
    const reason = timingAuthority?.authorityFresh === true ? timingAuthority.pendingReason : null;
    if (reason === 'robot-position') return t('timing.pending.robotPosition');
    if (reason === 'mix-idle') return t('timing.pending.mixIdle');
    return '';
  }

  function blockedText(reason) {
    const key = reason ? `timing.blocked.${reason}` : null;
    const copy = key ? t(key) : null;
    return copy && copy !== key ? copy : t('timing.unavailable');
  }

  function calibrationAuthority() {
    return authorityState({
      authorityFresh: productAuthority?.authorityFresh === true,
      lastKnownSnapshot: latestProductStatus,
      // No-Song boot preflight deliberately owns a separate short-lived
      // authenticated command socket. Its availability must not be coupled to
      // the publisher control socket that app.js uses for ordinary commands.
      // ProductStatus freshness, server ownership and server policy still gate
      // the action, and the preflight socket itself fails closed on auth/IO.
      commandChannelFresh: needsPreflightCommandPath()
        || commandAuthority?.commandChannelFresh === true,
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

    setText(calibrateLabel, t('timing.realign'));

    if (selfIsSecondMic()) {
      renderSecondMic();
      return;
    }

    const authority = calibrationAuthority();
    const reason = latestAction?.startCalibrationBlockedReason ?? null;
    // Whether the action may run is the server's question and it answers it
    // precisely. `timing.state` answers a different one - what the room's
    // alignment currently *is* - and reading it here made a background content
    // run, which holds nothing up and the singer cannot perceive, flip the
    // button between enabled and "Aligning…" every time one retried.
    const running = preflightCommandPending || reason === 'calibration-active';
    const owner = selfOwnsServerMic();

    if (commandError) {
      setHidden(!owner);
      setDisabled(true);
      setText(calibrateStatus, owner ? t('timing.unavailable') : '');
      return;
    }

    if (latestProductStatus && (!authority.authorityFresh || !authority.commandChannelFresh)) {
      // Only a page that holds or is publishing the Mic can realign. The
      // room-level canStartCalibration says the room could; it put every
      // listener's Realign on screen as "Reconnecting…", since a listener has
      // no command channel to be fresh.
      const relevant = owner || commandAuthority?.authorized === true;
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
      setText(calibrateStatus, pendingValueText());
      return;
    }

    setHidden(!owner);
    setDisabled(true);
    setText(calibrateStatus, owner && latestAction ? blockedText(reason) : '');
  }

  window.addEventListener('relay-product-status', (event) => {
    latestProductStatus = event.detail ?? null;
    latestAction = latestProductStatus?.actions ?? null;
    productAuthority = authorityState({
      authorityFresh: true,
      lastKnownSnapshot: latestProductStatus,
    });
    commandError = null;
    // The room has answered B's press, one way or the other.
    if (latestProductStatus?.room?.duet?.realigning !== undefined) secondMicRequestPending = false;
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
    if (selfIsSecondMic()) {
      if (calibrateButton.disabled) return;
      secondMicRequestPending = true;
      window.dispatchEvent(new CustomEvent('relay-choir-command', {
        detail: { type: 'choir-probe-request' },
      }));
      render();
      return;
    }
    if (!calibrationAuthority().actionable) return;

    // app.js sends the command over the publisher transport, but its check
    // requires a Song. Use a narrow authenticated command socket only for the
    // no-Song Robot preflight case; all normal commands keep flowing through
    // the established publisher transport.
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

    window.dispatchEvent(new CustomEvent('relay-start-timing-calibration'));
  });

  setHidden(true);
  setDisabled(true);
  render();
}

initialize();
