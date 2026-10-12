// "Relay was updated": shown when the shared authentication path reports that
// this page's build differs from the Relay it reconnected to (#487). Reloading
// stays the user's choice, because a reload stops a running Mic or Take.

const notice = document.querySelector('#update-notice');
const reload = document.querySelector('#update-notice-reload');

window.addEventListener('relay-page-outdated', () => {
  if (notice) notice.hidden = false;
});

reload?.addEventListener('click', () => {
  window.location.reload();
});
