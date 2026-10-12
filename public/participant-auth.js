/**
 * The build this page was served with (relay-build.ts), from the HTML Relay
 * wrote it into. Read once: it describes the code already running.
 */
const loadedBuild = typeof document === 'undefined'
  ? null
  : document.querySelector('meta[name="relay-build"]')?.getAttribute('content') || null;

let updateAnnounced = false;

/**
 * Sends the private browser capability inside the established WebSocket rather
 * than in its request URL. Reverse proxies and tunnel access logs commonly
 * retain request URLs; application messages stay inside the upgraded channel.
 */
export function participantAuthenticationPayload() {
  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId.trim()
    : '';
  const capability = typeof window.relayParticipantCapability === 'string'
    ? window.relayParticipantCapability.trim()
    : '';
  const nickname = typeof window.relayNickname === 'string'
    ? window.relayNickname.trim()
    : '';
  if (!participantId || !capability || !nickname) return null;
  const payload = {
    type: 'participant-authenticate',
    participantId,
    capability,
    nickname,
  };
  if (loadedBuild) payload.build = loadedBuild;
  return payload;
}

/**
 * Every Relay socket authenticates here, so this is the one place that
 * notices a page left open across a Relay update (#487). It announces it once
 * and never reloads by itself: the user may be singing or recording.
 */
function watchRelayBuild(socket) {
  if (!loadedBuild || updateAnnounced || typeof socket.addEventListener !== 'function') return;
  const onMessage = (event) => {
    if (typeof event.data !== 'string' || !event.data.includes('"participant-authenticated"')) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type !== 'participant-authenticated') return;
    socket.removeEventListener('message', onMessage);
    // A Relay from before builds existed sends none: nothing to compare.
    if (typeof message.build !== 'string' || message.build === loadedBuild || updateAnnounced) return;
    updateAnnounced = true;
    window.dispatchEvent(new CustomEvent('relay-page-outdated', {
      detail: { pageBuild: loadedBuild, relayBuild: message.build },
    }));
  };
  socket.addEventListener('message', onMessage);
}

export function sendParticipantAuthentication(socket) {
  const payload = participantAuthenticationPayload();
  if (!payload || !socket || typeof socket.send !== 'function') return false;
  watchRelayBuild(socket);
  socket.send(JSON.stringify(payload));
  return true;
}
