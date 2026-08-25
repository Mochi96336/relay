const peopleMenu = document.querySelector('.people-menu');
const moreMenu = document.querySelector('#room-more');
const systemPanel = document.querySelector('#system-panel');
const openSystem = document.querySelector('#open-system');
const closeSystem = document.querySelector('#close-system');
const calibrateTiming = document.querySelector('#calibrate-timing');
const micSectionLabel = document.querySelector('.performance-stage > .section-label');
const micInputDiagnostics = document.querySelector('.voice-input-evidence .evidence-heading');
const micLiveControl = document.querySelector('#mic-live-control');
const micLiveLabel = micLiveControl?.querySelector('summary span');

if (micSectionLabel) {
  micSectionLabel.removeAttribute('data-i18n');
  micSectionLabel.textContent = 'Mic';
}
if (micLiveLabel) {
  micLiveLabel.removeAttribute('data-i18n');
  micLiveLabel.textContent = 'Mic';
}

// Raw capture dBFS stays available to capture/diagnostics code through its DOM
// nodes, but it is not normal Live product copy.
if (micInputDiagnostics) {
  micInputDiagnostics.style.display = 'none';
  micInputDiagnostics.setAttribute('aria-hidden', 'true');
}

// The old gain recommendation was permanently hidden in production. Retire its
// render sentinel before app.js captures DOM references, so background input
// updates no longer keep calculating a product recommendation that no user can
// see. app.js still binds the compatibility action later in bootstrap; remove
// the remaining detached presentation only after that binding is safe.
document.querySelector('#mic-gain-advice')?.remove();

function removeDeadGainRecommendationPresentation() {
  for (const selector of [
    '#mic-gain-recommendation-marker',
    '.recommendation-meta',
  ]) {
    document.querySelector(selector)?.remove();
  }
}
window.addEventListener('load', removeDeadGainRecommendationPresentation, { once: true });

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

// Floor reconciliation is degradable presentation. System navigation is bound
// first so a viewport-module load failure can never block the recovery surface.
import('./live-floor-viewport.js')
  .then(({ installLiveFloorViewport }) => installLiveFloorViewport())
  .catch((error) => {
    console.error('Relay floor viewport presenter failed', error);
  });

function installCalibrationPresenter() {
  import('./calibration-ui.js').catch((error) => {
    console.error('Relay calibration presenter failed', error);
  });
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', installCalibrationPresenter, { once: true });
} else {
  installCalibrationPresenter();
}

calibrateTiming?.addEventListener('click', () => {
  if (moreMenu) moreMenu.open = false;
});

window.addEventListener('relay-microphone-local-state', (event) => {
  if (!micLiveControl) return;
  micLiveControl.open = event.detail?.active === true;
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (peopleMenu?.open) {
    event.preventDefault();
    peopleMenu.open = false;
    peopleMenu.querySelector(':scope > summary')?.focus({ preventScroll: true });
    return;
  }
  if (moreMenu?.open) {
    event.preventDefault();
    moreMenu.open = false;
    moreMenu.querySelector(':scope > summary')?.focus({ preventScroll: true });
    return;
  }
  if (systemPanel?.open) {
    event.preventDefault();
    closeSystemPanel(true);
  }
});

moreMenu?.querySelectorAll('[data-relay-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    moreMenu.open = false;
  });
});

for (const modulePath of [
  './mic-presence.js',
  './people-ui.js',
]) {
  import(modulePath).catch((error) => {
    console.error(`Relay presenter failed: ${modulePath}`, error);
  });
}
