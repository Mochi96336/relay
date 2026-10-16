import { sendParticipantAuthentication } from './participant-auth.js';
import { wsUrl } from './ws-url.js';
import { ChoirSecondaryCapture } from './choir-secondary-capture.js';
import { MIC_GAIN_KEY, storedNumber } from './device-preferences.js';

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
let announcedRoomEpoch = null;
const capture = new ChoirSecondaryCapture(() => disconnect());

function notify(state) {
  window.dispatchEvent(new CustomEvent('relay-choir-media-connection', {
    detail: { state },
  }));
}
/** Stops everything: B left, was refused, or capture failed. */
function disconnect() {
  roomReady = false;
  announcedRoomEpoch = null;
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
  const wasEnabled = enabled;
  enabled = event.detail?.enabled === true;
  if (!enabled && wasEnabled) disconnect();
  // A room announced while this module still waited for the mode.
  if (enabled && !wasEnabled) requestClaim();
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
  // The singer's own tap starts capture even if this module has not heard
  // Choir's mode yet (it can load after presence announced it). Media is
  // claimed only once the mode and a room are both known.
  if (preparing || capture.rate !== null) return;
  preparing = true;
  // The user's physical click initiates getUserMedia (not a server reply).
  // This path is NEVER started by an automatic invitation or login.
  try {
    const sourceRate = await capture.prepare();
    if (!sourceRate) return;
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
    const epoch = event.detail.roomEpoch;
    if (!Number.isSafeInteger(epoch) || epoch < 1
      || (announcedRoomEpoch !== null && epoch < announcedRoomEpoch)) return;
    // A repeated announcement while connecting must not close B's media and
    // retire the very room it is trying to join. A real disconnect can retry.
    if (epoch === announcedRoomEpoch && (awaitingClaim || mediaSocket)) return;
    announcedRoomEpoch = epoch;
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
  connectMedia(claimToken, roomEpoch, capture.rate, !directSocketFailed);
});

/**
 * B's media socket. Like the main Mic's (app.js), it tries Relay's direct
 * socket first, skipping the tunnel's detour, and stays on the tunnel for the
 * rest of the page once the direct one fails. The claim is spent only when
 * registration is sent, so a direct socket that never opened hands the same
 * claim to the tunnel.
 */
const DIRECT_SOCKET_OPEN_TIMEOUT_MS = 2_500;
let directSocketFailed = false;
function connectMedia(claimToken, roomEpoch, sourceRate, direct) {
  const tunnelUrl = wsUrl({ compress: false });
  const directUrl = wsUrl({ compress: false, direct: true });
  const viaDirect = direct && directUrl !== tunnelUrl;
  const socket = new WebSocket(viaDirect ? directUrl : tunnelUrl);
  mediaSocket = socket;
  let opened = false;
  let used = false;
  let registered = false;
  const fallBack = () => {
    if (socket !== mediaSocket || opened || !viaDirect) return false;
    directSocketFailed = true;
    try { socket.close(); } catch {}
    connectMedia(claimToken, roomEpoch, sourceRate, false);
    return true;
  };
  const openTimer = viaDirect ? setTimeout(fallBack, DIRECT_SOCKET_OPEN_TIMEOUT_MS) : null;
  socket.addEventListener('open', () => {
    opened = true;
    clearTimeout(openTimer);
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
      // This device's own last Mic gain, as the main Mic sends it.
      const micGainDb = storedNumber(MIC_GAIN_KEY, 0, 40);
      socket.send(JSON.stringify({
        type: 'choir-secondary-media-register',
        claimToken, packetVersion: 2, sampleRate: sourceRate,
        ...(micGainDb === null ? {} : { micGainDb }),
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
    clearTimeout(openTimer);
    if (fallBack()) return;
    if (socket !== mediaSocket) return;
    // The room was retired (seek, song change) or the link dropped; keep the
    // microphone and reconnect when the server announces the next room.
    closeMedia();
    notify('disconnected');
  });
  socket.addEventListener('error', () => {
    if (socket === mediaSocket && !fallBack()) socket.close();
  });
}

// B's local YouTube position, paired with the capture sample recorded then.
// Sent only while B's media is connected: the server cannot place samples it
// does not have.
window.addEventListener('relay-choir-song-anchor', (event) => {
  const detail = event.detail;
  if (!enabled || !mediaSocket || mediaSocket.readyState !== WebSocket.OPEN || !detail) return;
  const captureAnchor = capture.anchorFor(Number(detail.sampledAtPerformanceMs));
  if (!captureAnchor) return;
  window.dispatchEvent(new CustomEvent('relay-choir-consent-command', {
    detail: {
      type: 'choir-secondary-song-anchor', videoId: detail.videoId, state: detail.state,
      currentTime: detail.currentTime, playbackRate: detail.playbackRate, captureAnchor,
    },
  }));
});

// Presence may have announced Choir before this module finished loading.
window.dispatchEvent(new Event('relay-request-choir-media-mode'));
