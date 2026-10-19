import { sendParticipantAuthentication } from './participant-auth.js';
import { wsUrl } from './ws-url.js';
import { ChoirSecondaryCapture } from './choir-secondary-capture.js';
import { MIC_GAIN_KEY, storedNumber } from './device-preferences.js';
import { CalibrationProbePlayback } from './calibration-probe-playback.js';

/**
 * The second singer's publisher. B's own click on + Second Mic prepares a
 * separate AudioContext + existing capture Worklet, with actual native sample
 * rate and monotonically positioned PCM, and keeps it running while B is in.
 * It transmits binary ONLY on a media socket the server granted, and asks for
 * one whenever the server says so (media-ready, every 3 s until B has one).
 * The same socket carries B through songs, pauses and seeks; the server
 * measures B afresh for each song.
 *
 * Claim tokens exist only in an event-local closure and are never put in
 * URL parameters, browser storage, logs or page text.
 */
let enabled = false;
let mediaSocket = null;
let awaitingClaim = false;
let attempt = 0;
let claimTimer = null;
/** The server asked for media, waiting for capture to be ready. */
let mediaWanted = false;
let preparing = false;
let prepareAttempt = 0;
const capture = new ChoirSecondaryCapture((reason) => {
  disconnect();
  notify('capture-failed', reason);
});

// B's test tone: the main Mic's three notes, on B's own capture clock. The
// replies go back through the socket B joined from, under B's own names so
// they can never be taken for the main Mic's.
const REPLY_TYPES = {
  'calibration-probe-played': 'choir-probe-played',
  'calibration-probe-failed': 'choir-probe-failed',
};
const probePlayback = new CalibrationProbePlayback({
  getCapture: () => ({
    context: capture.context, sessionEpoch: capture.epoch, generation: capture.generation ?? 0,
  }),
  isCurrentCapture: (epoch, generation) => capture.epoch === epoch
    && capture.generation !== null && (capture.generation >>> 0) === generation,
  isControlOpen: () => enabled,
  sendControl: (message) => {
    const type = REPLY_TYPES[message.type];
    if (!type) return { sent: false, reason: 'unknown' };
    window.dispatchEvent(new CustomEvent('relay-choir-command', { detail: { ...message, type } }));
    return { sent: true };
  },
  onDisconnected: () => {},
});

function notify(state, reason = null) {
  window.dispatchEvent(new CustomEvent('relay-choir-media-connection', {
    detail: { state, reason },
  }));
}
/** Stops everything: B left, was refused, or capture failed. */
function disconnect() {
  ++prepareAttempt;
  preparing = false;
  mediaWanted = false;
  closeMedia();
  capture.stop();
}

/** Drops the media socket only; capture keeps running for the next one. */
function closeMedia() {
  ++attempt;
  probePlayback.retire();
  awaitingClaim = false;
  if (claimTimer !== null) clearTimeout(claimTimer);
  claimTimer = null;
  const old = mediaSocket;
  mediaSocket = null;
  if (old && old.readyState !== WebSocket.CLOSED) old.close();
}

/** Asks for a media claim, once capture is ready. */
function requestClaim() {
  if (!enabled || !mediaWanted || capture.rate === null || awaitingClaim) return;
  closeMedia();
  const current = attempt;
  awaitingClaim = true;
  mediaWanted = false;
  window.dispatchEvent(new CustomEvent('relay-choir-command', {
    detail: { type: 'choir-secondary-media-claim-request' },
  }));
  claimTimer = setTimeout(() => {
    if (attempt === current && awaitingClaim) {
      awaitingClaim = false;
      notify('claim-timeout');
    }
  }, 20_000);
}

window.addEventListener('relay-choir-stop-secondary-capture', disconnect);
window.addEventListener('relay-choir-pause-secondary-media', closeMedia);
window.addEventListener('relay-choir-availability', (event) => {
  const wasEnabled = enabled;
  enabled = event.detail?.available === true;
  if (!enabled && wasEnabled) disconnect();
  // Media asked for while this module still waited to hear Choir is on.
  if (enabled && !wasEnabled) requestClaim();
});
window.addEventListener('relay-choir-message', (event) => {
  const msg = event.detail;
  if (msg?.type === 'choir-secondary-consent-status' && msg.status === 'revoked'
    && msg.reason === 'connection-closed' && msg.secondaryId === window.relayParticipantId) {
    closeMedia();
    return;
  }
  if ((msg?.type === 'choir-secondary-consent-status'
    && ['withdrawn', 'revoked'].includes(msg.status)
    && msg.secondaryId === window.relayParticipantId)
    || msg?.type === 'choir-consent-rejected') disconnect();
});

window.addEventListener('relay-choir-start-secondary-capture', async () => {
  // The singer's own tap starts capture even if this module has not heard
  // that Choir is on yet (it can load after presence announced it). Media is
  // claimed only once it has, and the server asked for it.
  if (preparing || capture.rate !== null) return;
  preparing = true;
  const currentPrepare = ++prepareAttempt;
  // The user's physical click initiates getUserMedia (not a server reply).
  // This path is NEVER started by an automatic invitation or login.
  try {
    const sourceRate = await capture.prepare();
    if (currentPrepare !== prepareAttempt || !sourceRate) return;
    requestClaim();
  } catch {
    if (currentPrepare !== prepareAttempt) return;
    disconnect();
    notify('capture-failed');
  } finally {
    if (currentPrepare === prepareAttempt) preparing = false;
  }
});

window.addEventListener('relay-choir-media-message', (event) => {
  if (!enabled) return;
  if (event.detail?.type === 'choir-probe') {
    void probePlayback.play(event.detail.requestId, Number(event.detail.leadMs) || 300);
    return;
  }
  if (event.detail?.type === 'choir-media-ready') {
    // A socket B has, or one on the way, serves.
    if (awaitingClaim || mediaSocket) return;
    mediaWanted = true;
    requestClaim();
    return;
  }
  if (event.detail?.type === 'choir-media-rejected' && awaitingClaim) {
    // The join changed under the claim: wait for the server to ask again.
    closeMedia();
    notify('claim-rejected');
    return;
  }
  if (event.detail?.type !== 'choir-secondary-media-claim'
    || !awaitingClaim || capture.rate === null) return;
  const { claimToken } = event.detail;
  if (typeof claimToken !== 'string' || !/^[0-9a-f]{64}$/.test(claimToken)) return;
  awaitingClaim = false;
  if (claimTimer !== null) clearTimeout(claimTimer);
  claimTimer = null;
  connectMedia(claimToken, capture.rate, !directSocketFailed);
});

/**
 * B's media socket. Like the main Mic's (app.js), it tries Relay's direct
 * socket first, skipping the tunnel's detour, and stays on the tunnel for the
 * rest of the page once the direct one fails. The claim is spent only when
 * registration is sent, so a direct socket that never opened hands the same
 * claim to the tunnel.
 *
 * An open socket must also be registered within MEDIA_REGISTER_TIMEOUT_MS.
 * Otherwise the server's replies stopped (authentication or registration),
 * and the socket is dropped: the server's next media-ready (every 3 s) then
 * brings a fresh claim. While it was kept, media-ready was ignored and B
 * stayed in with no voice.
 */
const DIRECT_SOCKET_OPEN_TIMEOUT_MS = 2_500;
const MEDIA_REGISTER_TIMEOUT_MS = 5_000;
let directSocketFailed = false;
function connectMedia(claimToken, sourceRate, direct) {
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
    connectMedia(claimToken, sourceRate, false);
    return true;
  };
  const openTimer = viaDirect ? setTimeout(fallBack, DIRECT_SOCKET_OPEN_TIMEOUT_MS) : null;
  let registerTimer = null;
  socket.addEventListener('open', () => {
    opened = true;
    clearTimeout(openTimer);
    registerTimer = setTimeout(() => {
      if (socket !== mediaSocket || registered) return;
      // A direct socket that opens but goes quiet is a failed direct path.
      if (viaDirect) directSocketFailed = true;
      closeMedia();
      notify('disconnected', 'register-timeout');
    }, MEDIA_REGISTER_TIMEOUT_MS);
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
        claimToken, packetVersion: capture.packetVersion, sampleRate: sourceRate,
        ...(micGainDb === null ? {} : { micGainDb }),
      }));
    } else if (message.type === 'choir-secondary-media-registered') {
      if (!used || registered) {
        socket.close();
        return;
      }
      if (!capture.attach(socket, message.sampleRate)) {
        socket.close();
        return;
      }
      registered = true;
      clearTimeout(registerTimer);
      notify('registered');
    } else if (message.type === 'choir-media-rejected'
      || message.type === 'participant-auth-rejected') {
      socket.close();
    }
  });
  socket.addEventListener('close', () => {
    clearTimeout(openTimer);
    clearTimeout(registerTimer);
    if (fallBack()) return;
    if (socket !== mediaSocket) return;
    // The link dropped or B's join ended; keep the microphone and reconnect
    // when the server next asks (media-ready, every 3 s).
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
  window.dispatchEvent(new CustomEvent('relay-choir-command', {
    detail: {
      type: 'choir-secondary-song-anchor', videoId: detail.videoId, state: detail.state,
      currentTime: detail.currentTime, playbackRate: detail.playbackRate, captureAnchor,
    },
  }));
});

// Presence may have announced Choir before this module finished loading.
window.dispatchEvent(new Event('relay-request-choir-availability'));
