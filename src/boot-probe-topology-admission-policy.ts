export type BootProbeTopologyFacts = {
  /** Optional only for legacy pure-policy callers that predate explicit Robot topology. */
  backingIsRobot?: boolean;
  /** Optional only for legacy pure-policy callers that predate explicit Robot topology. */
  robotSourceConnected?: boolean;
};

/**
 * Whether both infrastructure-owned legs of a Robot boot-probe route exist.
 *
 * Automatic scheduling and product/manual admission must share this invariant:
 * admitting the Mic leg when the Robot backing or Source leg cannot exist can
 * strand a bounded run forever without spending another attempt. `undefined`
 * remains permissive only for legacy pure-policy callers; runtime callers pass
 * both facts explicitly and therefore fail closed.
 */
export function bootProbeTopologyReady(facts: BootProbeTopologyFacts) {
  return facts.backingIsRobot !== false && facts.robotSourceConnected !== false;
}
