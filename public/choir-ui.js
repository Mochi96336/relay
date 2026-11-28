import './live-i18n.js';
// Evaluated before this module: + 副 Mic must not be tappable before the
// media client listens for the capture its tap starts. As a separate page
// script it could finish loading seconds later, and the tap was lost.
import './choir-media-client.js';

/**
 * The second Mic's controls, in the Mic row like Take Mic: + 副 Mic to join
 * whoever holds the Mic, 接手副 Mic when someone else is the second singer
 * (it can be taken over, as the Mic can), and 離開副 Mic once in. Progress
 * stays in the heading (live-status.js); the Mic row contains only controls.
 */
const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const joinButton = document.querySelector('#choir-invite-open');
const leaveButton = document.querySelector('#choir-withdraw');

const captureNotice = document.querySelector('#choir-capture-notice');
let noticeKey = null;
let available = false;
let session = null;
let authorityFresh = false;
let joined = false;
let pending = false;
let joinScope = null;
let recovering = false;
let recoveryTimer = null;
/** The second singer the room has now (from product status), or null. */
let duetSecondaryId = null;
// The Mic owner's phone is playing a local file only it can hear.
let roomLocalFile = false;
let pendingTimer = null;
let lastReport = '';
let lastReportAtMs = Number.NEGATIVE_INFINITY;

function myId() {
  return typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId : null;
}
function canJoin() {
  return available && authorityFresh && Boolean(myId())
    && typeof session?.micOwnerId === 'string' && session.micOwnerId !== myId()
    && session?.micConnected === true && !joined && !roomLocalFile;
}
function publishCommand(type, fields = {}) {
  if (!available || !authorityFresh) return false;
  window.dispatchEvent(new CustomEvent('relay-choir-command', {
    detail: { type, ...fields },
  }));
  return true;
}
function render() {
  if (!joinButton || !leaveButton) return;
  if (captureNotice) {
    const offlineTimeout = available && !authorityFresh && noticeKey === 'choir.recoveryTimedOut';
    let notice = '';
    if (recoveryTimer !== null) notice = t('choir.reconnectingMic');
    else if (noticeKey && (canJoin() || offlineTimeout)) notice = t(noticeKey);
    captureNotice.hidden = !notice;
    if (captureNotice.textContent !== notice) captureNotice.textContent = notice;
  }
  const takeOver = typeof duetSecondaryId === 'string' && !joined;
  joinButton.hidden = !canJoin();
  joinButton.disabled = pending;
  // Also the data-i18n key: applyStatic() rewrites every [data-i18n]
  // node, and would put + 副 Mic back over 接手副 Mic.
  joinButton.dataset.i18n = takeOver ? 'choir.takeOver' : 'choir.invite';
  joinButton.textContent = t(joinButton.dataset.i18n);
  leaveButton.hidden = !(available && joined);
  if (joined) document.body.dataset.choirGuest = 'joined';
  else delete document.body.dataset.choirGuest;
  window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: {
      enabled: available && joined,
      captureRequested: joinScope !== null,
      reconnecting: recoveryTimer !== null,
    },
  }));
}
function resetJoin() {
  clearTimeout(pendingTimer);
  clearTimeout(recoveryTimer);
  recoveryTimer = null;
  joinScope = null;
  if (noticeKey === 'choir.preparingMic') noticeKey = null;
  recovering = false;
  window.dispatchEvent(new Event('relay-choir-stop-secondary-capture'));
  joined = false;
  pending = false;
  render();
}

function expireJoin() {
  if (joinScope?.waitingForCapture) noticeKey = 'choir.captureTimedOut';
  else {
    noticeKey = joined ? 'choir.recoveryTimedOut' : 'choir.joinTimedOut';
    publishCommand('choir-secondary-withdraw', { reason: 'join-timeout' });
  }
  resetJoin();
}

// A brief control outage revokes the server ticket, but the user's join
// intent and running microphone survive for 15 s. Only the same room owner
// and server may resume it, through fresh authenticated server admission.
function resumeIfReady() {
  if (!recovering || !authorityFresh || !available) return;
  if (!joinScope || typeof joinScope.serverIncarnation !== 'string'
    || session?.micOwnerId !== joinScope.primaryId
    || session?.serverIncarnation !== joinScope.serverIncarnation) {
    resetJoin();
    return;
  }
  if (session?.micConnected !== true) return;
  recovering = false;
  pending = publishCommand('choir-secondary-join', {
    resume: true, expectedPrimaryId: joinScope.primaryId,
  });
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { if (pending) expireJoin(); }, 8_000);
}
function recoverControl() {
  if (!joined || recovering || !joinScope) return;
  recovering = true;
  window.dispatchEvent(new Event('relay-choir-pause-secondary-media'));
  pending = false;
  clearTimeout(pendingTimer);
  recoveryTimer ??= setTimeout(expireJoin, 15_000);
}

window.addEventListener('relay-presence-state', (event) => {
  session = event.detail?.session ?? null;
  authorityFresh = event.detail?.authorityFresh === true;
  if (!authorityFresh) {
    if (pending && !joined) resetJoin();
    else recoverControl();
  }
  // A join still waiting for admission belongs to the Mic owner it was
  // pressed for, exactly as an admitted one does.
  else if ((joined || pending) && joinScope && (session?.micOwnerId !== joinScope.primaryId
    || session?.serverIncarnation !== joinScope.serverIncarnation)) resetJoin();
  resumeIfReady();
  render();
});
window.addEventListener('relay-choir-availability', (event) => {
  available = event.detail?.available === true;
  if (!available) {
    noticeKey = null;
    resetJoin();
  }
  resumeIfReady();
  render();
});
window.addEventListener('relay-product-status', (event) => {
  const next = event.detail?.room?.duet?.secondaryId ?? null;
  const localFile = Boolean(event.detail?.room?.localFile);
  if (next === duetSecondaryId && localFile === roomLocalFile) return;
  duetSecondaryId = next;
  roomLocalFile = localFile;
  render();
});
window.addEventListener('relay-choir-message', (event) => {
  if (!available || !authorityFresh) return;
  // During local preparation this attempt has not sent a join yet.
  if (joinScope?.waitingForCapture) return;
  const message = event.detail;
  if (message?.type === 'choir-consent-rejected') {
    if (joinScope) noticeKey = message.reason === 'seat-changed' ? 'choir.seatChanged' : 'choir.joinRefused';
    resetJoin();
    return;
  }
  if (message?.type !== 'choir-secondary-consent-status' || message.secondaryId !== myId()) return;
  if (message.status === 'accepted') {
    // A reply can arrive after the permission attempt failed or timed out.
    // Only a still-active user intent may revive the second microphone.
    if (!joinScope) {
      publishCommand('choir-secondary-withdraw', { reason: 'join-cancelled' });
      return;
    }
    // Admitted to someone else's Mic (the owner changed in flight): this
    // singer asked to join the owner they saw, so do not sing under another.
    if (typeof message.primaryId === 'string' && message.primaryId !== joinScope.primaryId) {
      publishCommand('choir-secondary-withdraw', { reason: 'join-cancelled' });
      resetJoin();
      return;
    }
    clearTimeout(pendingTimer);
    joined = true;
    recovering = false;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    pending = false;
    render();
  } else if (message.status === 'withdrawn') {
    resetJoin();
  } else if (message.status === 'revoked') {
    if (message.reason === 'connection-closed') { recoverControl(); resumeIfReady(); render(); }
    else {
      if (message.reason === 'replaced') noticeKey = 'choir.replaced';
      resetJoin();
    }
  }
});
window.addEventListener('relay-choir-media-connection', (event) => {
  if (!available || !joinScope || (!joined && !pending)) return;
  if (event.detail?.state === 'capture-ready') {
    if (!joinScope.waitingForCapture) return;
    if (!canJoin()) { resetJoin(); return; }
    joinScope.waitingForCapture = false;
    noticeKey = null;
    publishCommand('choir-secondary-join', {
      expectedPrimaryId: joinScope.primaryId, expectedSecondaryId: joinScope.secondaryId,
    });
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(expireJoin, 8_000);
    render();
    return;
  }
  // Media reconnects on its own for each room; only a microphone that will
  // not open needs the singer. Leave rather than sit joined but silent.
  if (event.detail?.state !== 'capture-failed') return;
  noticeKey = event.detail.reason === 'permission-denied' ? 'voice.permissionRequired' : 'choir.captureFailed';
  if (!joinScope.waitingForCapture) publishCommand('choir-secondary-withdraw', { reason: `capture-failed:${event.detail?.reason ?? 'unknown'}` });
  resetJoin();
});
// What B's page shows and plays, for the server log: on change (at most once
// a second) and every 10 s while joined.
window.addEventListener('relay-choir-follower-report', (event) => {
  if (!joined || !available) return;
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
  noticeKey = 'choir.preparingMic';
  // Start capture in the tap gesture. Keep the current singer in place
  // until this page has a working capture to offer.
  pending = true;
  joinScope = {
    primaryId: session.micOwnerId, secondaryId: duetSecondaryId,
    serverIncarnation: session.serverIncarnation, waitingForCapture: true,
  };
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(expireJoin, 20_000);
  // Silence this page's copy of the room mix before opening the input.
  render();
  window.dispatchEvent(new Event('relay-choir-start-secondary-capture'));
});
leaveButton?.addEventListener('click', () => {
  if (!joined) return;
  publishCommand('choir-secondary-withdraw', { reason: 'user' });
  resetJoin();
});
render();
window.dispatchEvent(new Event('relay-request-presence-state'));
window.dispatchEvent(new Event('relay-request-choir-availability'));
