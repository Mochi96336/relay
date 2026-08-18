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

// Recalibration is a direct task in More, not a reason to navigate into a
// generic Adjust surface. app.js still owns whether the action is allowed and
// what command is sent; this layer only gets the popover out of the way.
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

// Secondary navigation is a P0 interaction path. Keep it outside the failure
// domain of optional presentation modules: a syntax/runtime/load failure in a
// Mic ribbon, Room sound wording, People projection, recording projection, or
// Mic action presenter must never prevent System from opening. Dynamic import
// failures are contained after all navigation handlers above are installed.
for (const modulePath of [
  './mic-presence.js',
  './room-sound-ui.js',
  './people-ui.js',
  './recording-ui.js',
  './mic-actions.js',
]) {
  import(modulePath).catch((error) => {
    console.error(`Relay optional presenter failed: ${modulePath}`, error);
  });
}
