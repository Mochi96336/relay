const peopleMenu = document.querySelector('.people-menu');
const moreMenu = document.querySelector('#room-more');
const systemPanel = document.querySelector('#system-panel');
const openSystem = document.querySelector('#open-system');
const closeSystem = document.querySelector('#close-system');
const calibrateTiming = document.querySelector('#calibrate-timing');
const calibrateStatus = document.querySelector('#calibrate-status');
const micLiveControl = document.querySelector('#mic-live-control');
const micLiveLabel = micLiveControl?.querySelector('summary span');
const performanceStage = document.querySelector('.performance-stage');
const lastTake = document.querySelector('#last-take');

// "Mic" is the product term in every locale: it is the same object the user
// takes/releases, not a translated mixer channel named Voice/人聲. The template
// still carries the historical i18n hook for compatibility; retire it here
// before future locale changes can rewrite this row.
if (micLiveLabel) {
  micLiveLabel.removeAttribute('data-i18n');
  micLiveLabel.textContent = 'Mic';
}

// The rehearsal loop is Sing -> Record -> Adjust -> Review. The historical
// template nested the recent Take inside the recording section, which made Mic
// gain split the action flow or forced the recent Take above gain. Move only the
// preview node; Take history keeps its own global IDs and authority unchanged.
if (performanceStage && micLiveControl && lastTake) {
  performanceStage.insertBefore(lastTake, micLiveControl.nextSibling);
}

function closeHeaderMenus(except = null) {
  for (const menu of [peopleMenu, moreMenu]) {
    if (menu && menu !== except) menu.open = false;
  }
}

function takeHistoryPanel() {
  return document.querySelector('#take-history-panel');
}

function closeTakeHistoryPanel() {
  const panel = takeHistoryPanel();
  if (panel?.open) panel.open = false;
}

function closeSystemPanel(restoreFocus = true) {
  if (!systemPanel) return;
  systemPanel.open = false;
  if (restoreFocus) openSystem?.focus({ preventScroll: true });
}

function revealSystem() {
  if (!systemPanel) return;
  closeTakeHistoryPanel();
  closeHeaderMenus();
  systemPanel.open = true;
  requestAnimationFrame(() => {
    closeSystem?.focus({ preventScroll: true });
  });
}

function revealTakeHistory() {
  const panel = takeHistoryPanel();
  if (!panel) return;
  closeSystemPanel(false);
  closeHeaderMenus();
  panel.open = true;
  requestAnimationFrame(() => {
    panel.querySelector('#close-take-history')?.focus({ preventScroll: true });
  });
}

peopleMenu?.addEventListener('toggle', () => {
  if (peopleMenu.open) closeHeaderMenus(peopleMenu);
});

moreMenu?.addEventListener('toggle', () => {
  if (moreMenu.open) closeHeaderMenus(moreMenu);
});

systemPanel?.addEventListener('toggle', () => {
  if (!systemPanel.open) return;
  closeTakeHistoryPanel();
  closeHeaderMenus();
});

openSystem?.addEventListener('click', revealSystem);
window.addEventListener('relay-open-system', revealSystem);
window.addEventListener('relay-open-take-history', revealTakeHistory);
closeSystem?.addEventListener('click', () => closeSystemPanel(true));

systemPanel?.addEventListener('click', (event) => {
  if (event.target === systemPanel) closeSystemPanel(true);
});

function calibrationCopy(key) {
  const zh = window.relayI18n?.getLocale?.() === 'zh-Hant';
  if (key === 'realign') return zh ? '重新對齊' : 'Realign';
  if (key === 'aligning') return zh ? '對齊中…' : 'Aligning…';
  if (key === 'preparing-paths') return zh ? '正在準備聲音路徑…' : 'Preparing audio paths…';
  return '';
}

let latestCalibrationAction = null;
let calibrationRenderQueued = false;

function setElementText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

/**
 * ProductStatus is the semantic authority for calibration prerequisites.
 * app.js still owns the command socket and content-correlation progress UI;
 * this presenter prevents its historical `roomSongAvailable` projection from
 * leaking Song/timeline prerequisites into the Robot boot-probe route.
 */
function renderCalibrationAction() {
  calibrationRenderQueued = false;
  if (!calibrateTiming) return;

  calibrateTiming.removeAttribute('data-i18n');
  const action = latestCalibrationAction;
  const mode = action?.startCalibrationMode ?? null;
  const reason = action?.startCalibrationBlockedReason ?? null;
  const bootProbe = mode === 'boot-probe';
  const bootProbeRunning = bootProbe && reason === 'calibration-active';
  const bootProbePreparing = bootProbe
    && (reason === 'sources-not-connected' || reason === 'sources-not-streaming');

  if (!bootProbe) {
    setElementText(calibrateTiming, calibrationCopy('realign'));
    if (calibrateTiming.hidden) calibrateTiming.hidden = false;
    return;
  }

  if (bootProbeRunning) {
    if (calibrateTiming.hidden) calibrateTiming.hidden = false;
    if (!calibrateTiming.disabled) calibrateTiming.disabled = true;
    setElementText(calibrateTiming, calibrationCopy('aligning'));
    setElementText(calibrateStatus, calibrationCopy('aligning'));
    return;
  }

  setElementText(calibrateTiming, calibrationCopy('realign'));

  if (bootProbePreparing) {
    // A disabled recovery action is noise while the PCM capture timelines are
    // still becoming fresh. Keep the preparation state, not a fake Song error.
    if (!calibrateTiming.hidden) calibrateTiming.hidden = true;
    setElementText(calibrateStatus, calibrationCopy('preparing-paths'));
    return;
  }

  if (calibrateTiming.hidden) calibrateTiming.hidden = false;
  const localMicOwner = document.body.dataset.selfMic === 'live';
  const shouldDisable = action?.canStartCalibration !== true || !localMicOwner;
  if (calibrateTiming.disabled !== shouldDisable) calibrateTiming.disabled = shouldDisable;

  // A ready boot probe does not need Song or phone-timeline helper copy. Leave
  // the action itself as the recovery affordance.
  if (action?.canStartCalibration === true) setElementText(calibrateStatus, '');
}

function queueCalibrationRender() {
  if (calibrationRenderQueued) return;
  calibrationRenderQueued = true;
  queueMicrotask(renderCalibrationAction);
}

window.addEventListener('relay-product-status', (event) => {
  latestCalibrationAction = event.detail?.actions ?? null;
  // app.js subscribes to the same event later in the module graph. Render in a
  // microtask so ProductStatus semantics win after that legacy projection.
  queueCalibrationRender();
});
window.addEventListener('relay-microphone-local-state', queueCalibrationRender);
window.addEventListener('relay-locale-changed', queueCalibrationRender);

// app.js also updates calibration status when raw calibration messages arrive.
// In boot-probe mode ProductStatus remains the semantic source; re-project it
// after those DOM writes so `No song to align` can never reappear.
if (calibrateTiming && calibrateStatus) {
  const calibrationObserver = new MutationObserver(queueCalibrationRender);
  calibrationObserver.observe(calibrateTiming, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  calibrationObserver.observe(calibrateStatus, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

// Realignment is a direct recovery task in More, not a reason to navigate into
// a generic Adjust surface. app.js still owns whether the command is sent; this
// layer only gets the popover out of the way.
calibrateTiming?.addEventListener('click', () => {
  if (moreMenu) moreMenu.open = false;
});

window.addEventListener('relay-microphone-local-state', (event) => {
  if (event.detail?.active === true) return;
  if (micLiveControl?.open) micLiveControl.open = false;
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (systemPanel?.open) {
    closeSystemPanel(true);
    return;
  }
  if (micLiveControl?.open) micLiveControl.open = false;
});

moreMenu?.querySelectorAll('[data-relay-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    moreMenu.open = false;
  });
});

// Only projections that can disappear without removing a product control stay
// in this failure domain. Core Mic, Room sound, and Recording presenters are
// parser-loaded modules in index.html because they are now the sole writers of
// those action surfaces.
for (const modulePath of [
  './mic-presence.js',
  './people-ui.js',
]) {
  import(modulePath).catch((error) => {
    console.error(`Relay optional presenter failed: ${modulePath}`, error);
  });
}
