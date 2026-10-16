import './live-i18n.js';
// Evaluated before this module: + 副 Mic must not be tappable before the
// media client listens for the capture its tap starts. As a separate page
// script it could finish loading seconds later, and the tap was lost.
import './choir-secondary-media-client.js';

/**
 * The second Mic's controls, in the Mic row like Take Mic: + 副 Mic to join
 * whoever holds the Mic, 接手副 Mic when someone else is the second singer
 * (it can be taken over, as the Mic can), and 離開副 Mic once in. Progress
 * stays in the heading (live-status.js); the Mic row contains only controls.
 */
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const joinButton = document.querySelector('#choir-invite-open');
const leaveButton = document.querySelector('#choir-withdraw');

let available = false;
let session = null;
let authorityFresh = false;
let mediaEnabled = false;
let joined = false;
let pending = false;
/** The second singer the room has now (from product status), or null. */
let duetSecondaryId = null;
let pendingTimer = null;
let lastReport = '';
let lastReportAtMs = Number.NEGATIVE_INFINITY;

function myId() {
  return typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId : null;
}
function canJoin() {
  return available && authorityFresh && mediaEnabled && Boolean(myId())
    && typeof session?.micOwnerId === 'string' && session.micOwnerId !== myId()
    && session?.micConnected === true && !joined;
}
function publishCommand(type, fields = {}) {
  if (!available || !authorityFresh) return false;
  window.dispatchEvent(new CustomEvent('relay-choir-consent-command', {
    detail: { type, ...fields },
  }));
  return true;
}
function render() {
  if (!joinButton || !leaveButton) return;
  const takeOver = typeof duetSecondaryId === 'string' && duetSecondaryId !== myId();
  joinButton.hidden = !canJoin();
  joinButton.disabled = pending;
  // Also the data-i18n key: applyStatic() rewrites every [data-i18n]
  // node, and would put + 副 Mic back over 接手副 Mic.
  joinButton.dataset.i18n = takeOver ? 'choir.takeOver' : 'choir.invite';
  joinButton.textContent = t(joinButton.dataset.i18n);
  leaveButton.hidden = !(available && authorityFresh && joined);
  if (joined) document.body.dataset.choirGuest = 'joined';
  else delete document.body.dataset.choirGuest;
  window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: available && authorityFresh && joined && mediaEnabled },
  }));
}
function resetJoin() {
  clearTimeout(pendingTimer);
  joined = false;
  pending = false;
  render();
}

window.addEventListener('relay-presence-state', (event) => {
  session = event.detail?.session ?? null;
  authorityFresh = event.detail?.authorityFresh === true;
  if (!authorityFresh) joined = false;
  render();
});
window.addEventListener('relay-choir-consent-availability', (event) => {
  available = event.detail?.available === true;
  if (!available) {
    joined = false;
    pending = false;
  }
  render();
});
window.addEventListener('relay-choir-media-mode', (event) => {
  mediaEnabled = event.detail?.enabled === true;
  render();
});
window.addEventListener('relay-product-status', (event) => {
  const next = event.detail?.room?.duet?.secondaryId ?? null;
  if (next === duetSecondaryId) return;
  duetSecondaryId = next;
  render();
});
window.addEventListener('relay-choir-consent-message', (event) => {
  if (!available || !authorityFresh) return;
  const message = event.detail;
  if (message?.type === 'choir-consent-rejected') {
    resetJoin();
    return;
  }
  if (message?.type !== 'choir-secondary-consent-status' || message.secondaryId !== myId()) return;
  if (message.status === 'accepted') {
    clearTimeout(pendingTimer);
    joined = true;
    pending = false;
    render();
  } else if (message.status === 'withdrawn') {
    resetJoin();
  } else if (message.status === 'revoked') {
    resetJoin();
  }
});
window.addEventListener('relay-choir-media-connection', (event) => {
  if (!mediaEnabled || !joined) return;
  // Media reconnects on its own for each room; only a microphone that will
  // not open needs the singer. Leave rather than sit joined but silent.
  if (event.detail?.state !== 'capture-failed') return;
  publishCommand('choir-secondary-withdraw');
  resetJoin();
});
// What B's page shows and plays, for the server log: on change (at most once
// a second) and every 10 s while joined.
window.addEventListener('relay-choir-follower-report', (event) => {
  if (!joined || !mediaEnabled) return;
  const report = JSON.stringify(event.detail ?? null);
  const nowMs = performance.now();
  if ((report === lastReport && nowMs - lastReportAtMs < 10_000) || nowMs - lastReportAtMs < 1_000) return;
  lastReport = report;
  lastReportAtMs = nowMs;
  publishCommand('choir-secondary-page', { page: event.detail });
});
window.addEventListener('relay-locale-changed', render);
window.addEventListener('relay-request-choir-guest-state', render);

joinButton?.addEventListener('click', () => {
  if (!canJoin() || pending) return;
  // Inside the click: iOS and other browsers require a user gesture for the
  // microphone. Capture starts now and connects once the server has a room.
  window.dispatchEvent(new Event('relay-choir-start-secondary-capture'));
  pending = publishCommand('choir-secondary-join');
  clearTimeout(pendingTimer);
  // An unanswered join must not leave the button disabled.
  pendingTimer = setTimeout(() => { if (pending && !joined) resetJoin(); }, 8_000);
  render();
});
leaveButton?.addEventListener('click', () => {
  if (!joined) return;
  publishCommand('choir-secondary-withdraw');
});
render();
window.dispatchEvent(new Event('relay-request-presence-state'));
window.dispatchEvent(new Event('relay-request-choir-media-mode'));
