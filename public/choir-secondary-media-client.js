import { sendParticipantAuthentication } from './participant-auth.js';
import { wsUrl } from './ws-url.js';

/**
 * Double-opt-in control-to-media join only. This deliberately DOES NOT ask
 * for microphone access or stream PCM. A true native capture clock and
 * calibration proof must be implemented before physical secondary audio
 * starts; the server keeps this transport muted until verified Content.
 *
 * Claim tokens exist only in an event-local closure and are never put in
 * URL parameters, browser storage, logs or page text.
 */
let enabled = false;
let mediaSocket = null;

function notify(state) {
  window.dispatchEvent(new CustomEvent('relay-choir-media-connection', {
    detail: { state },
  }));
}
function disconnect() {
  const old = mediaSocket;
  mediaSocket = null;
  if (old && old.readyState !== WebSocket.CLOSED) old.close();
}

window.addEventListener('relay-choir-media-mode', (event) => {
  enabled = event.detail?.enabled === true;
  if (!enabled) disconnect();
});
window.addEventListener('relay-choir-consent-message', (event) => {
  const msg = event.detail;
  if (msg?.type === 'choir-secondary-consent-status'
    && ['withdrawn', 'revoked'].includes(msg.status)
    && msg.secondaryId === window.relayParticipantId) disconnect();
});

window.addEventListener('relay-choir-media-message', (event) => {
  if (!enabled || event.detail?.type !== 'choir-secondary-media-claim') return;
  const { claimToken, roomEpoch } = event.detail;
  if (typeof claimToken !== 'string' || !/^[0-9a-f]{64}$/.test(claimToken)
    || !Number.isSafeInteger(roomEpoch) || roomEpoch < 1) return;
  disconnect();

  const socket = new WebSocket(wsUrl({ compress: false }));
  mediaSocket = socket;
  let used = false;
  let registered = false;
  socket.addEventListener('open', () => {
    if (socket !== mediaSocket || !enabled
      || !sendParticipantAuthentication(socket)) {
      socket.close();
    }
  });
  socket.addEventListener('message', (event) => {
    if (socket !== mediaSocket || typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'participant-authenticated') {
      if (used || message.participantId !== window.relayParticipantId) {
        socket.close();
        return;
      }
      used = true;
      socket.send(JSON.stringify({
        type: 'choir-secondary-media-register',
        claimToken, packetVersion: 2, sampleRate: 48_000,
      }));
    } else if (message.type === 'choir-secondary-media-registered') {
      if (!used || registered || message.roomEpoch !== roomEpoch
        || message.awaitingContent !== true) {
        socket.close();
        return;
      }
      registered = true;
      notify('registered');
      // No PCM is sent until a user-initiated second-Mic capture component
      // obtains and validates an actual native capture generation.
    } else if (message.type === 'choir-media-rejected'
      || message.type === 'participant-auth-rejected') {
      socket.close();
    }
  });
  socket.addEventListener('close', () => {
    if (socket !== mediaSocket) return;
    mediaSocket = null;
    notify('disconnected');
  });
  socket.addEventListener('error', () => {
    if (socket === mediaSocket) socket.close();
  });
});
