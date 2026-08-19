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

  if (!bootProbe) {
    setText(calibrateButton, copy('realign'));
    if (calibrateButton.hidden) calibrateButton.hidden = false;
    return;
  }

  if (bootProbeRunning) {
    if (calibrateButton.hidden) calibrateButton.hidden = false;
    calibrateButton.disabled = true;
    setText(calibrateButton, copy('aligning'));
    setText(calibrateStatus, copy('aligning'));
    return;
  }

  setText(calibrateButton, copy('realign'));

  if (bootProbePreparing) {
    // A disabled recovery action is noise while the PCM capture timelines are
    // still becoming fresh. Show the path preparation state instead.
    calibrateButton.hidden = true;
    setText(calibrateStatus, copy('preparing-paths'));
    return;
  }

  if (calibrateButton.hidden) calibrateButton.hidden = false;
  const localMicOwner = document.body.dataset.selfMic === 'live';
  calibrateButton.disabled = latestAction?.canStartCalibration !== true || !localMicOwner;

  // A ready Robot probe needs neither Song nor phone-timeline helper copy.
  if (latestAction?.canStartCalibration === true) setText(calibrateStatus, '');
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
