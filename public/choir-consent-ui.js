import './live-i18n.js';
// Evaluated before this module: + Second Mic must not be tappable before the
// media client listens for the capture its tap starts. As a separate page
// script it could finish loading seconds later, and the tap was lost.
import './choir-secondary-media-client.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const trigger = document.querySelector('#choir-invite-open');
const panel = document.querySelector('#choir-consent-panel');
const host = document.querySelector('#choir-host-actions');
const guest = document.querySelector('#choir-guest-actions');
const beginRoomButton = document.querySelector('#choir-room-begin');
const connectMediaButton = document.querySelector('#choir-secondary-connect');
const invitationCopy = document.querySelector('#choir-invitation-copy');
const acceptButton = document.querySelector('#choir-accept');
const declineButton = document.querySelector('#choir-decline');
const withdrawPanel = document.querySelector('#choir-withdraw-actions');
const withdrawButton = document.querySelector('#choir-withdraw');
const statusCopy = document.querySelector('#choir-consent-status');
const closeButton = document.querySelector('#choir-consent-close');

let available = false;
let session = null;
let authorityFresh = false;
let invitation = null;
let acceptedAsGuest = false;
let mediaEnabled = false;
let pendingSend = false;
/** Someone else is already the second singer (from product status). */
let duetTaken = false;
/** A join was tried: keep the panel open to say how it went until closed. */
let joinFeedback = false;
let statusKey = null;
let statusVars = null;

function myId() {
  return typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId : null;
}
function participant(id) {
  return session?.participants?.find(p => p.id === id) ?? null;
}
/** Someone else holds a live Mic, so this person can join as the second singer. */
function canJoin() {
  return available && authorityFresh && mediaEnabled && Boolean(myId())
    && typeof session?.micOwnerId === 'string' && session.micOwnerId !== myId()
    && session?.micConnected === true && !acceptedAsGuest && !duetTaken;
}
function publishCommand(type, fields = {}) {
  if (!available || !authorityFresh) return false;
  window.dispatchEvent(new CustomEvent('relay-choir-consent-command', {
    detail: { type, ...fields },
  }));
  return true;
}
function render() {
  if (!trigger || !panel || !host || !guest || !statusCopy) return;
  // The second singer joins by their own press; the Mic owner invites no one,
  // and the server creates the room itself once a song plays.
  trigger.hidden = !canJoin();
  trigger.disabled = !canJoin() || pendingSend;
  const hasGuestInvitation = Boolean(invitation && !acceptedAsGuest);
  const show = available && authorityFresh
    && (hasGuestInvitation || acceptedAsGuest || joinFeedback);
  panel.hidden = !show;
  trigger.setAttribute('aria-expanded', String(!panel.hidden));
  host.hidden = true;
  beginRoomButton.hidden = true;
  connectMediaButton.hidden = true;
  guest.hidden = !hasGuestInvitation;
  withdrawPanel.hidden = !acceptedAsGuest;
  closeButton.hidden = acceptedAsGuest;
  if (invitation) {
    invitationCopy.textContent = t('choir.invitationFrom', {
      name: participant(invitation.primaryId)?.nickname ?? t('voice.someone'),
    });
  } else {
    invitationCopy.textContent = '';
  }
  statusCopy.textContent = statusKey ? t(statusKey, statusVars ?? {}) : '';
  if (acceptedAsGuest) document.body.dataset.choirGuest = 'joined';
  else delete document.body.dataset.choirGuest;
  window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: available && authorityFresh && acceptedAsGuest && mediaEnabled },
  }));
}
function resetConnection() {
  available = false;
  invitation = null;
  acceptedAsGuest = false;
  mediaEnabled = false;
  pendingSend = false;
  statusKey = null;
  statusVars = null;
  render();
}

window.addEventListener('relay-presence-state', (event) => {
  session = event.detail?.session ?? null;
  authorityFresh = event.detail?.authorityFresh === true;
  if (!authorityFresh) resetConnection();
  render();
});
window.addEventListener('relay-choir-consent-availability', (event) => {
  if (event.detail?.available !== true) resetConnection();
  else available = true;
  render();
});
window.addEventListener('relay-choir-consent-message', (event) => {
  if (!available || !authorityFresh) return;
  const message = event.detail;
  switch (message?.type) {
    case 'choir-secondary-invitation':
      if (typeof message.inviteId !== 'string'
        || typeof message.primaryId !== 'string'
        || !Number.isSafeInteger(message.roomEpoch)) return;
      invitation = {
        inviteId: message.inviteId,
        primaryId: message.primaryId,
        roomEpoch: message.roomEpoch,
      };
      acceptedAsGuest = false;
      statusKey = null;
      break;
    case 'choir-secondary-invite-acknowledged':
      pendingSend = false;
      statusKey = 'choir.inviteAcknowledged';
      break;
    case 'choir-secondary-consent-status':
      pendingSend = false;
      if (message.status === 'accepted') {
        acceptedAsGuest = message.secondaryId === myId();
        // The heading shows a joined singer's progress from here on.
        if (acceptedAsGuest) joinFeedback = false;
        statusKey = message.joined === true ? null : 'choir.accepted';
      } else if (['withdrawn', 'revoked', 'declined'].includes(message.status)) {
        const wasGuest = acceptedAsGuest && message.secondaryId === myId();
        if (message.secondaryId === myId()) {
          acceptedAsGuest = false;
          invitation = null;
        }
        statusKey = message.status === 'declined' ? 'choir.declined'
          : message.status === 'withdrawn' ? 'choir.withdrawn' : 'choir.revoked';
        // Ended by the server (the Mic changed hands, a link dropped): say so
        // in the open panel instead of only changing the heading.
        if (wasGuest && message.status === 'revoked') joinFeedback = true;
      }
      break;
    case 'choir-consent-rejected':
      pendingSend = false;
      statusKey = 'choir.joinRejected';
      break;
    default:
      return;
  }
  render();
});
window.addEventListener('relay-choir-media-mode', (event) => {
  mediaEnabled = event.detail?.enabled === true;
  render();
});
window.addEventListener('relay-choir-media-connection', (event) => {
  if (!mediaEnabled || !authorityFresh || !acceptedAsGuest) return;
  // Media reconnects on its own for each room; only a microphone that will
  // not open needs the singer. Leave rather than sit joined but silent.
  if (event.detail?.state !== 'capture-failed') return;
  publishCommand('choir-secondary-withdraw');
  acceptedAsGuest = false;
  joinFeedback = true;
  statusKey = 'choir.micFailed';
  render();
});
window.addEventListener('relay-product-status', (event) => {
  const duet = event.detail?.room?.duet;
  const taken = Boolean(duet && duet.secondaryId !== myId());
  if (taken === duetTaken) return;
  duetTaken = taken;
  render();
});
window.addEventListener('relay-locale-changed', render);
window.addEventListener('relay-request-choir-guest-state', render);

trigger?.addEventListener('click', () => {
  if (!canJoin() || pendingSend) return;
  joinFeedback = true;
  // Inside the click: iOS and other browsers require a user gesture for the
  // microphone. Capture starts now and connects once the server has a room.
  window.dispatchEvent(new Event('relay-choir-start-secondary-capture'));
  pendingSend = publishCommand('choir-secondary-join');
  if (pendingSend) statusKey = 'choir.joining';
  render();
});
acceptButton?.addEventListener('click', () => {
  if (!invitation || acceptedAsGuest) return;
  if (publishCommand('choir-secondary-accept', { inviteId: invitation.inviteId }))
    statusKey = 'choir.responding';
  render();
});
declineButton?.addEventListener('click', () => {
  if (!invitation || acceptedAsGuest) return;
  if (publishCommand('choir-secondary-decline', { inviteId: invitation.inviteId })) {
    invitation = null;
    statusKey = 'choir.declined';
  }
  render();
});
withdrawButton?.addEventListener('click', () => {
  if (!acceptedAsGuest) return;
  if (publishCommand('choir-secondary-withdraw')) statusKey = 'choir.responding';
  render();
});
closeButton?.addEventListener('click', () => {
  joinFeedback = false;
  statusKey = null;
  // B's invite remains visible until explicitly answered or revoked.
  render();
});
render();
window.dispatchEvent(new Event('relay-request-presence-state'));
window.dispatchEvent(new Event('relay-request-choir-media-mode'));
