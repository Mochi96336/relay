const root = document.querySelector('.local-sound-control');
const title = document.querySelector('#local-listen-label');
const scope = root?.querySelector('.adjust-group-heading > span:not(#local-listen-label)');
const volumeLabel = root?.querySelector('.adjust-row-heading strong');

function chinese() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant';
}

function renderCopy() {
  if (!root || !title || !scope || !volumeLabel) return;
  // These labels describe the product boundary, not an implementation module.
  // listen.js still owns every audible/muted state and the actual WebAudio path.
  title.textContent = chinese() ? '房間聲音' : 'Room sound';
  scope.textContent = chinese() ? '只影響這支裝置' : 'This device only';
  volumeLabel.textContent = chinese() ? '音量' : 'Volume';
}

for (const node of [title, scope, volumeLabel]) {
  node?.removeAttribute('data-i18n');
}

renderCopy();
window.addEventListener('relay-locale-changed', renderCopy);
