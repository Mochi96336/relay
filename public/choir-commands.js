/** A page-supplied reason, cut to `max`, or 'unspecified'. */
const reason = (value, max) => (typeof value === 'string' ? value.slice(0, max) : 'unspecified');

/**
 * The second Mic commands a page may send through Presence, each with the
 * only fields it may carry, so a page event never takes anything else to the
 * server. Never a browser capability; the server still checks the Mic owner
 * and B's actual identity.
 */
const COMMANDS = new Map([
  ['choir-secondary-join', (p) => (p.resume === true
    ? { resume: true, expectedPrimaryId: p.expectedPrimaryId } : {})],
  ['choir-secondary-withdraw', (p) => ({ reason: reason(p.reason, 80) })],
  ['choir-secondary-media-claim-request', () => ({})],
  ['choir-secondary-gain', (p) => ({ micGainDb: p.micGainDb })],
  ['choir-secondary-page', (p) => ({ page: p.page })],
  ['choir-secondary-song-anchor', (p) => ({
    videoId: p.videoId, state: p.state, currentTime: p.currentTime,
    playbackRate: p.playbackRate, captureAnchor: p.captureAnchor,
  })],
  ['choir-probe-request', () => ({})],
  ['choir-probe-played', (p) => ({
    requestId: p.requestId, generation: p.generation, timingDiagnostics: p.timingDiagnostics,
  })],
  ['choir-probe-failed', (p) => ({
    requestId: p.requestId, generation: p.generation, reason: reason(p.reason, 200),
  })],
]);

/** The server message for a second Mic command, or null for anything that is not one. */
export function choirCommandMessage(payload) {
  const fields = COMMANDS.get(payload?.type);
  return fields ? { type: payload.type, ...fields(payload) } : null;
}
