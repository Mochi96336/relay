import './mic-presence.js';

const peopleMenu = document.querySelector('.people-menu');
const moreMenu = document.querySelector('#room-more');
const adjustPanel = document.querySelector('.adjust-panel');
const systemPanel = document.querySelector('#system-panel');
const openAdjust = document.querySelector('#open-adjust');
const openSystem = document.querySelector('#open-system');
const closeAdjust = document.querySelector('#close-adjust');
const closeSystem = document.querySelector('#close-system');
const liveActions = document.querySelector('.live-actions');
const localListen = document.querySelector('.local-listen');
const listenAction = document.querySelector('.listen-action');

function promoteLocalSoundControl() {
  if (!liveActions || !localListen) return;

  const heading = localListen.querySelector('.adjust-group-heading');
  const toggle = listenAction?.querySelector('#listen-toggle');
  const note = listenAction?.querySelector('#listen-note');

  localListen.classList.remove('adjust-group');
  localListen.classList.add('local-sound-control');

  if (heading && toggle) heading.append(toggle);
  if (note) localListen.append(note);

  liveActions.prepend(localListen);
  listenAction?.remove();
}

// live-ia.js loads before listen.js. Move the existing Listen controls first so
// the audio owner binds to the final product-facing DOM instead of a settings
// panel. No audio state or authority is duplicated here.
promoteLocalSoundControl();

function closeHeaderMenus(except = null) {
  for (const menu of [peopleMenu, moreMenu]) {
    if (menu && menu !== except) menu.open = false;
  }
}

function revealPanel(panel, otherPanel, focusTarget) {
  if (!panel) return;
  if (otherPanel) otherPanel.open = false;
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
  if (adjustPanel.open && systemPanel) systemPanel.open = false;
});

systemPanel?.addEventListener('toggle', () => {
  if (systemPanel.open && adjustPanel) adjustPanel.open = false;
});

openAdjust?.addEventListener('click', () => revealPanel(adjustPanel, systemPanel, closeAdjust));
openSystem?.addEventListener('click', () => revealPanel(systemPanel, adjustPanel, closeSystem));

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