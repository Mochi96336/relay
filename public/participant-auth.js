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
  return {
    type: 'participant-authenticate',
    participantId,
    capability,
    nickname,
  };
}

export function sendParticipantAuthentication(socket) {
  const payload = participantAuthenticationPayload();
  if (!payload || !socket || typeof socket.send !== 'function') return false;
  socket.send(JSON.stringify(payload));
  return true;
}
