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

function revealPanel(panel, otherPanel) {
  if (!panel) return;
  if (otherPanel) otherPanel.open = false;
  closeHeaderMenus();
  panel.open = true;
  requestAnimationFrame(() => {
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

openAdjust?.addEventListener('click', () => revealPanel(adjustPanel, systemPanel));
openSystem?.addEventListener('click', () => revealPanel(systemPanel, adjustPanel));

closeAdjust?.addEventListener('click', () => {
  if (adjustPanel) adjustPanel.open = false;
});

closeSystem?.addEventListener('click', () => {
  if (systemPanel) systemPanel.open = false;
});

moreMenu?.querySelectorAll('[data-relay-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    moreMenu.open = false;
  });
});
