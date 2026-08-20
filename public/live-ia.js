const peopleMenu = document.querySelector('.people-menu');
const moreMenu = document.querySelector('#room-more');
const systemPanel = document.querySelector('#system-panel');
const openSystem = document.querySelector('#open-system');
const closeSystem = document.querySelector('#close-system');
const calibrateTiming = document.querySelector('#calibrate-timing');
const micLiveControl = document.querySelector('#mic-live-control');
const micLiveLabel = micLiveControl?.querySelector('summary span');

// "Mic" is the product term in every locale: it is the same object the user
// takes/releases, not a translated mixer channel named Voice/人聲. The template
// still carries the historical i18n hook for compatibility; retire it here
// before future locale changes can rewrite this row.
if (micLiveLabel) {
  micLiveLabel.removeAttribute('data-i18n');
  micLiveLabel.textContent = 'Mic';
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

// Core System/Take navigation must exist even if a semantic presenter fails.
// Calibration is installed only after deferred module evaluation completes so
// app.js has already captured its compatibility command node. calibration-ui
// then replaces the painted nodes and becomes their sole visible presenter.
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

// Realignment is a direct recovery task in More, not a reason to navigate into
// a generic Adjust surface. app.js owns the authenticated command transport;
// calibration-ui forwards a real user click to this captured compatibility node.
calibrateTiming?.addEventListener('click', () => {
  if (moreMenu) moreMenu.open = false;
});

window.addEventListener('relay-microphone-local-state', (event) => {
  if (!micLiveControl) return;
  micLiveControl.open = event.detail?.active === true;
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (systemPanel?.open) {
    closeSystemPanel(true);
  }
});

moreMenu?.querySelectorAll('[data-relay-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    moreMenu.open = false;
  });
});

// Only projections that can disappear without removing a product control stay
// in this failure domain. Core Mic, Room sound, Recording, and calibration
// semantics have dedicated presenters because they own product actions.
for (const modulePath of [
  './mic-presence.js',
  './people-ui.js',
]) {
  import(modulePath).catch((error) => {
    console.error(`Relay optional presenter failed: ${modulePath}`, error);
  });
}
