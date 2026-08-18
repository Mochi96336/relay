import './mic-presence.js';

const peopleMenu = document.querySelector('.people-menu');
const moreMenu = document.querySelector('#room-more');
const adjustPanel = document.querySelector('.adjust-panel');
const systemPanel = document.querySelector('#system-panel');
const openAdjust = document.querySelector('#open-adjust');
const openSystem = document.querySelector('#open-system');
const closeAdjust = document.querySelector('#close-adjust');
const closeSystem = document.querySelector('#close-system');

function closeHeaderMenus(except = null) {
  for (const menu of [peopleMenu, moreMenu]) {
    if (menu && menu !== except) menu.open = false;
  }
}

function closeTakeHistoryPanel() {
  const panel = document.querySelector('#take-history-panel');
  if (panel?.open) panel.open = false;
}

function revealPanel(panel, otherPanel, focusTarget) {
  if (!panel) return;
  if (otherPanel) otherPanel.open = false;
  closeTakeHistoryPanel();
  closeHeaderMenus();
  panel.open = true;
  requestAnimationFrame(() => {
    focusTarget?.focus({ preventScroll: true });
  });
}

function closePanel(panel, restoreFocus) {
  if (!panel) return;
  panel.open = false;
  restoreFocus?.focus({ preventScroll: true });
}

function closeOnBackdrop(panel, restoreFocus) {
  panel?.addEventListener('click', (event) => {
    if (event.target === panel) closePanel(panel, restoreFocus);
  });
}

peopleMenu?.addEventListener('toggle', () => {
  if (peopleMenu.open) closeHeaderMenus(peopleMenu);
});

moreMenu?.addEventListener('toggle', () => {
  if (moreMenu.open) closeHeaderMenus(moreMenu);
});

adjustPanel?.addEventListener('toggle', () => {
  if (!adjustPanel.open) return;
  if (systemPanel) systemPanel.open = false;
  closeTakeHistoryPanel();
  closeHeaderMenus();
});

systemPanel?.addEventListener('toggle', () => {
  if (!systemPanel.open) return;
  if (adjustPanel) adjustPanel.open = false;
  closeTakeHistoryPanel();
  closeHeaderMenus();
});

openAdjust?.addEventListener('click', () => revealPanel(adjustPanel, systemPanel, closeAdjust));
openSystem?.addEventListener('click', () => revealPanel(systemPanel, adjustPanel, closeSystem));
window.addEventListener('relay-open-system', () => revealPanel(systemPanel, adjustPanel, closeSystem));

closeAdjust?.addEventListener('click', () => closePanel(adjustPanel, openAdjust));
closeSystem?.addEventListener('click', () => closePanel(systemPanel, openSystem));

closeOnBackdrop(adjustPanel, openAdjust);
closeOnBackdrop(systemPanel, openSystem);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (systemPanel?.open) {
    closePanel(systemPanel, openSystem);
    return;
  }
  if (adjustPanel?.open) closePanel(adjustPanel, openAdjust);
});

moreMenu?.querySelectorAll('[data-relay-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    moreMenu.open = false;
  });
});