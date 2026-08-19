const peopleMenu = document.querySelector('.people-menu');
const moreMenu = document.querySelector('#room-more');
const systemPanel = document.querySelector('#system-panel');
const openSystem = document.querySelector('#open-system');
const closeSystem = document.querySelector('#close-system');
const calibrateTiming = document.querySelector('#calibrate-timing');
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

// Product action presenters must not be static dependencies of the IA bootstrap:
// System/Take navigation is a core recovery path and must already be installed if
// a semantic presenter fails to evaluate. Calibration still owns its own module;
// this file only schedules it after the core navigation bindings exist.
import('./calibration-ui.js').catch((error) => {
  console.error('Relay calibration presenter failed', error);
});

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