import './live-i18n.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const trigger = document.querySelector('#choir-invite-open');
const panel = document.querySelector('#choir-consent-panel');
const host = document.querySelector('#choir-host-actions');
const guest = document.querySelector('#choir-guest-actions');
const select = document.querySelector('#choir-secondary-person');
const inviteButton = document.querySelector('#choir-invite-send');
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
let panelOpen = false;
let invitation = null;
let acceptedAsGuest = false;
let acceptedSecondaryId = null;
let mediaEnabled = false;
let pendingSend = false;
let statusKey = null;
let statusVars = null;

function myId() {
  return typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId : null;
}
function participant(id) {
  return session?.participants?.find(p => p.id === id) ?? null;
}
function otherSingers() {
  return Array.isArray(session?.participants)
    ? session.participants.filter(p => p.connected && p.id !== myId())
    : [];
}
function isHost() {
  return available && authorityFresh && Boolean(myId())
    && session?.micOwnerId === myId() && session?.micConnected === true;
}
function publishCommand(type, fields = {}) {
  if (!available || !authorityFresh) return false;
  window.dispatchEvent(new CustomEvent('relay-choir-consent-command', {
    detail: { type, ...fields },
  }));
  return true;
}
function render() {
  if (!trigger || !panel || !host || !guest || !select || !statusCopy) return;
  const hostAllowed = isHost();
  const choices = hostAllowed ? otherSingers() : [];
  trigger.hidden = !hostAllowed || choices.length === 0;
  trigger.disabled = !hostAllowed || choices.length === 0;
  const hasGuestInvitation = Boolean(invitation && !acceptedAsGuest);
  const show = available && authorityFresh
    && ((panelOpen && hostAllowed) || hasGuestInvitation || acceptedAsGuest);
  panel.hidden = !show;
  trigger.setAttribute('aria-expanded', String(!panel.hidden && hostAllowed));
  host.hidden = !hostAllowed || !panelOpen;
  guest.hidden = !hasGuestInvitation;
  withdrawPanel.hidden = !acceptedAsGuest;
  closeButton.hidden = acceptedAsGuest;
  beginRoomButton.hidden = !mediaEnabled || !hostAllowed
    || !panelOpen || !acceptedSecondaryId;
  connectMediaButton.hidden = !mediaEnabled || !acceptedAsGuest;

  const selected = select.value;
  select.replaceChildren();
  for (const singer of choices) {
    const option = document.createElement('option');
    option.value = singer.id;
    // Never interpolate untrusted nicknames into HTML.
    option.textContent = singer.nickname;
    select.append(option);
  }
  if (choices.some(p => p.id === selected)) select.value = selected;
  inviteButton.disabled = !choices.length || pendingSend;
  if (invitation) {
    invitationCopy.textContent = t('choir.invitationFrom', {
      name: participant(invitation.primaryId)?.nickname ?? t('voice.someone'),
    });
  } else {
    invitationCopy.textContent = '';
  }
  statusCopy.textContent = statusKey ? t(statusKey, statusVars ?? {}) : '';
  window.dispatchEvent(new CustomEvent('relay-choir-guest-state', {
    detail: { enabled: available && authorityFresh && acceptedAsGuest && mediaEnabled },
  }));
}
function resetConnection() {
  available = false;
  panelOpen = false;
  invitation = null;
  acceptedAsGuest = false;
  acceptedSecondaryId = null;
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
        if (!acceptedAsGuest && isHost()) acceptedSecondaryId = message.secondaryId;
        statusKey = 'choir.accepted';
      } else if (['withdrawn', 'revoked', 'declined'].includes(message.status)) {
        if (message.secondaryId === acceptedSecondaryId)
          acceptedSecondaryId = null;
        if (message.secondaryId === myId()) {
          acceptedAsGuest = false;
          invitation = null;
        }
        statusKey = message.status === 'declined' ? 'choir.declined'
          : message.status === 'withdrawn' ? 'choir.withdrawn' : 'choir.revoked';
      }
      break;
    case 'choir-consent-rejected':
      pendingSend = false;
      statusKey = 'choir.rejected';
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
window.addEventListener('relay-choir-media-message', (event) => {
  if (!mediaEnabled || !authorityFresh) return;
  const message = event.detail;
  if (message?.type === 'choir-room-ready') statusKey = 'choir.roomReady';
  else if (message?.type === 'choir-secondary-media-claim')
    statusKey = 'choir.connecting';
  else if (message?.type === 'choir-media-rejected')
    statusKey = 'choir.mediaRejected';
  else return;
  render();
});
window.addEventListener('relay-choir-media-connection', (event) => {
  if (!mediaEnabled || !authorityFresh) return;
  statusKey = event.detail?.state === 'registered'
    ? 'choir.mediaReady' : 'choir.mediaRejected';
  render();
});
window.addEventListener('relay-locale-changed', render);
window.addEventListener('relay-request-choir-guest-state', render);

trigger?.addEventListener('click', () => {
  if (!isHost()) return;
  panelOpen = !panelOpen;
  render();
});
inviteButton?.addEventListener('click', () => {
  if (!isHost() || !otherSingers().some(p => p.id === select.value)
    || pendingSend) return;
  pendingSend = publishCommand('choir-secondary-invite', {
    secondaryId: select.value,
  });
  if (pendingSend) statusKey = 'choir.sending';
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
beginRoomButton?.addEventListener('click', () => {
  if (!mediaEnabled || !isHost() || !acceptedSecondaryId) return;
  if (publishCommand('choir-room-begin', { secondaryId: acceptedSecondaryId }))
    statusKey = 'choir.connecting';
  render();
});
connectMediaButton?.addEventListener('click', () => {
  if (!mediaEnabled || !acceptedAsGuest || !authorityFresh) return;
  // Dispatch inside the actual click handler: iOS and other browsers
  // require a user gesture for the *separate* B microphone permission.
  // The client requests a short-lived media claim only AFTER capture is ready
  // and the actual hardware sample rate is known.
  window.dispatchEvent(new Event('relay-choir-start-secondary-capture'));
  statusKey = 'choir.preparingMic';
  render();
});
closeButton?.addEventListener('click', () => {
  panelOpen = false;
  // B's invite remains visible until explicitly answered or revoked.
  render();
});
render();
window.dispatchEvent(new Event('relay-request-presence-state'));
