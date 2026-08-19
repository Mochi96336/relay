const calibrateButton = document.querySelector('#calibrate-timing');
const calibrateStatus = document.querySelector('#calibrate-status');

function copy(key) {
  const zh = window.relayI18n?.getLocale?.() === 'zh-Hant';
  if (key === 'realign') return zh ? '重新對齊' : 'Realign';
  if (key === 'aligning') return zh ? '對齊中…' : 'Aligning…';
  if (key === 'preparing-paths') return zh ? '正在準備聲音路徑…' : 'Preparing audio paths…';
  return '';
}

let latestAction = null;
let renderQueued = false;

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
 * ProductStatus owns calibration prerequisites. app.js still owns the command
 * socket and content-correlation progress, while this presenter prevents its
 * historical Song projection from leaking Song/timeline requirements into a
 * Robot boot-probe recovery.
 */
function render() {
  renderQueued = false;
  if (!calibrateButton) return;

  calibrateButton.removeAttribute('data-i18n');
  const mode = latestAction?.startCalibrationMode ?? null;
  const reason = latestAction?.startCalibrationBlockedReason ?? null;
  const bootProbe = mode === 'boot-probe';
  const bootProbeRunning = bootProbe && reason === 'calibration-active';
  const bootProbePreparing = bootProbe
    && (reason === 'sources-not-connected' || reason === 'sources-not-streaming');

  // Content correlation keeps its existing visibility/eligibility projection.
  // This module only replaces the retired Recalibrate label for that mode; it
  // must not make a content action visible or executable by itself.
  if (!bootProbe) {
    setText(calibrateButton, copy('realign'));
    return;
  }

  if (bootProbeRunning) {
    setHidden(false);
    setDisabled(true);
    setText(calibrateButton, copy('aligning'));
    setText(calibrateStatus, copy('aligning'));
    return;
  }

  setText(calibrateButton, copy('realign'));

  if (bootProbePreparing) {
    // A disabled recovery action is noise while the PCM capture timelines are
    // still becoming fresh. Show the path preparation state instead.
    setHidden(true);
    setDisabled(true);
    setText(calibrateStatus, copy('preparing-paths'));
    return;
  }

  if (latestAction?.canStartCalibration === true) {
    // Robot semantics deliberately bypass Song/timeline state. ProductStatus
    // says the capture paths are ready; local ownership is the remaining UI
    // execution gate because only the phone publishing the Mic can run it.
    const localMicOwner = document.body.dataset.selfMic === 'live';
    if (!localMicOwner) {
      // Healthy timing should not leave a permanent disabled recovery action.
      setHidden(true);
      setDisabled(true);
      return;
    }

    setHidden(false);
    setDisabled(false);
    setText(calibrateStatus, '');
    return;
  }

  // Unknown/future Robot blocks belong to the centralized policy owner. Do not
  // invent presentation semantics here or accidentally unhide an action that
  // another projection intentionally hid.
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(render);
}

window.addEventListener('relay-product-status', (event) => {
  latestAction = event.detail?.actions ?? null;
  // app.js subscribes later and still contains the content-correlation legacy
  // projection. Re-render after the current event dispatch so semantic mode wins.
  queueRender();
});
window.addEventListener('relay-microphone-local-state', queueRender);
window.addEventListener('relay-locale-changed', queueRender);

// app.js also writes raw calibration progress. In Robot mode we always restore
// ProductStatus semantics after those writes, preventing "No song to align"
// from resurfacing during boot-probe preparation or execution.
if (calibrateButton && calibrateStatus) {
  const observer = new MutationObserver(queueRender);
  observer.observe(calibrateButton, { attributes: true, childList: true, subtree: true });
  observer.observe(calibrateStatus, { childList: true, characterData: true, subtree: true });
}

// Replace the legacy Recalibrate label immediately, before room status arrives.
render();
