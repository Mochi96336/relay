import { sendParticipantAuthentication } from './participant-auth.js';
import { wsUrl } from './ws-url.js';
import { ChoirSecondaryCapture } from './choir-secondary-capture.js';

/**
 * Double-opt-in isolated secondary publisher. An explicit B click prepares
 * a separate AudioContext + existing capture Worklet, with actual native
 * sample rate and monotonically positioned PCM. It may transmit v2 binary
 * ONLY after a freshly verified server Media Epoch has been bound.
 * The server remains acoustically muted until separate trusted Content proof.
 *
 * Claim tokens exist only in an event-local closure and are never put in
 * URL parameters, browser storage, logs or page text.
 */
let enabled = false;
let mediaSocket = null;
let awaitingClaim = false;
let attempt = 0;
let claimTimer = null;
const capture = new ChoirSecondaryCapture(() => disconnect());

function notify(state) {
  window.dispatchEvent(new CustomEvent('relay-choir-media-connection', {
    detail: { state },
  }));
}
function disconnect() {
  ++attempt;
  awaitingClaim = false;
  if (claimTimer !== null) clearTimeout(claimTimer);
  claimTimer = null;
  capture.stop();
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

window.addEventListener('relay-choir-start-secondary-capture', async () => {
  if (!enabled || awaitingClaim || mediaSocket) return;
  const current = ++attempt;
  awaitingClaim = true;
  // The user's physical click initiates getUserMedia (not a server reply).
  // This path is NEVER started by an automatic invitation or login.
  try {
    const sourceRate = await capture.prepare();
    if (attempt !== current || !enabled || !sourceRate) return;
    window.dispatchEvent(new CustomEvent('relay-choir-consent-command', {
      detail: { type: 'choir-secondary-media-claim-request' },
    }));
    claimTimer = setTimeout(() => {
      if (attempt === current && awaitingClaim) {
        disconnect();
        notify('claim-timeout');
      }
    }, 20_000);
  } catch {
    if (attempt === current) {
      disconnect();
      notify('capture-failed');
    }
  }
});

window.addEventListener('relay-choir-media-message', (event) => {
  if (!enabled) return;
  if (event.detail?.type === 'choir-media-rejected' && awaitingClaim) {
    disconnect();
    notify('claim-rejected');
    return;
  }
  if (event.detail?.type !== 'choir-secondary-media-claim'
    || !awaitingClaim || capture.rate === null) return;
  const { claimToken, roomEpoch } = event.detail;
  if (typeof claimToken !== 'string' || !/^[0-9a-f]{64}$/.test(claimToken)
    || !Number.isSafeInteger(roomEpoch) || roomEpoch < 1) return;
  awaitingClaim = false;
  if (claimTimer !== null) clearTimeout(claimTimer);
  claimTimer = null;
  const sourceRate = capture.rate;
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
        claimToken, packetVersion: 2, sampleRate: sourceRate,
      }));
    } else if (message.type === 'choir-secondary-media-registered') {
      if (!used || registered || message.roomEpoch !== roomEpoch
        || message.awaitingContent !== true) {
        socket.close();
        return;
      }
      if (!capture.attach(socket, message.sampleRate)) {
        socket.close();
        return;
      }
      registered = true;
      notify('registered');
    } else if (message.type === 'choir-media-rejected'
      || message.type === 'participant-auth-rejected') {
      socket.close();
    }
  });
  socket.addEventListener('close', () => {
    if (socket !== mediaSocket) return;
    disconnect();
    notify('disconnected');
  });
  socket.addEventListener('error', () => {
    if (socket === mediaSocket) socket.close();
  });
});
