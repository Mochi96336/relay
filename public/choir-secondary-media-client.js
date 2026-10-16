import { sendParticipantAuthentication } from './participant-auth.js';
import { wsUrl } from './ws-url.js';
import { ChoirSecondaryCapture } from './choir-secondary-capture.js';

/**
 * The second singer's publisher. B's own click on + Second Mic prepares a
 * separate AudioContext + existing capture Worklet, with actual native sample
 * rate and monotonically positioned PCM, and keeps it running while B is in.
 * It transmits v2 binary ONLY on a media socket bound to a server-issued
 * Media Epoch. It asks for one whenever the server says a duet room is ready,
 * which happens when a song plays and again after each seek or song change,
 * so B never has to press anything twice. The server keeps B silent until
 * both singers are aligned.
 *
 * Claim tokens exist only in an event-local closure and are never put in
 * URL parameters, browser storage, logs or page text.
 */
let enabled = false;
let mediaSocket = null;
let awaitingClaim = false;
let attempt = 0;
let claimTimer = null;
/** The latest room the server announced, waiting for capture to be ready. */
let roomReady = false;
const capture = new ChoirSecondaryCapture(() => disconnect());

function notify(state) {
  window.dispatchEvent(new CustomEvent('relay-choir-media-connection', {
    detail: { state },
  }));
}
/** Stops everything: B left, was refused, or capture failed. */
function disconnect() {
  roomReady = false;
  closeMedia();
  capture.stop();
}

/** Drops the media socket only; capture keeps running for the next room. */
function closeMedia() {
  ++attempt;
  awaitingClaim = false;
  if (claimTimer !== null) clearTimeout(claimTimer);
  claimTimer = null;
  const old = mediaSocket;
  mediaSocket = null;
  if (old && old.readyState !== WebSocket.CLOSED) old.close();
}

/** Asks for a Media Epoch for the announced room, once capture is ready. */
function requestClaim() {
  if (!enabled || !roomReady || capture.rate === null || awaitingClaim) return;
  closeMedia();
  const current = attempt;
  awaitingClaim = true;
  roomReady = false;
  window.dispatchEvent(new CustomEvent('relay-choir-consent-command', {
    detail: { type: 'choir-secondary-media-claim-request' },
  }));
  claimTimer = setTimeout(() => {
    if (attempt === current && awaitingClaim) {
      awaitingClaim = false;
      notify('claim-timeout');
    }
  }, 20_000);
}

window.addEventListener('relay-choir-media-mode', (event) => {
  enabled = event.detail?.enabled === true;
  if (!enabled) disconnect();
});
window.addEventListener('relay-choir-consent-message', (event) => {
  const msg = event.detail;
  if ((msg?.type === 'choir-secondary-consent-status'
    && ['withdrawn', 'revoked'].includes(msg.status)
    && msg.secondaryId === window.relayParticipantId)
    || msg?.type === 'choir-consent-rejected') disconnect();
});

let preparing = false;
window.addEventListener('relay-choir-start-secondary-capture', async () => {
  if (!enabled || preparing || capture.rate !== null) return;
  preparing = true;
  // The user's physical click initiates getUserMedia (not a server reply).
  // This path is NEVER started by an automatic invitation or login.
  try {
    const sourceRate = await capture.prepare();
    if (!enabled || !sourceRate) return;
    requestClaim();
  } catch {
    disconnect();
    notify('capture-failed');
  } finally {
    preparing = false;
  }
});

window.addEventListener('relay-choir-media-message', (event) => {
  if (!enabled) return;
  if (event.detail?.type === 'choir-room-ready') {
    roomReady = true;
    requestClaim();
    return;
  }
  if (event.detail?.type === 'choir-media-rejected' && awaitingClaim) {
    // No room yet, or it was just retired: wait for the next one.
    closeMedia();
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
    // The room was retired (seek, song change) or the link dropped; keep the
    // microphone and reconnect when the server announces the next room.
    closeMedia();
    notify('disconnected');
  });
  socket.addEventListener('error', () => {
    if (socket === mediaSocket) socket.close();
  });
});
