import type { ReadinessSnapshot } from './readiness.js';

export type RemoteStatusState = 'idle' | 'live' | 'degraded' | 'fault';

export type RemoteStatusHealth = {
  ok: boolean;
  state: RemoteStatusState;
  faults: string[];
  warnings: string[];
};

/**
 * Interprets one canonical readiness snapshot for the unauthenticated /statusz
 * operator surface.
 *
 * This is intentionally a projection rather than another sampler. The server
 * decides facts once in readinessPayload(); this function only decides what
 * those facts mean to an unattended operator. Keeping the interpretation pure
 * prevents /statusz, observation status and the product UI from each reading
 * mutable transport globals at slightly different times.
 */
export function deriveRemoteStatusHealth(readiness: ReadinessSnapshot): RemoteStatusHealth {
  const components = readiness.components;
  const routeMode = components.route.mode;
  const robotRoute = routeMode === 'robot';

  const faults: string[] = [];
  if (components.backing.connected && !components.backing.streaming) {
    faults.push('backing source is connected but no longer sending audio');
  }

  // "No longer" requires evidence that this Mic capture has actually flowed.
  // A newly acquired Mic before its first frame is starting, not broken.
  if (components.mic.connected && components.mic.flowObserved && !components.mic.streaming) {
    faults.push('microphone is connected but no longer sending audio');
  }

  if (routeMode !== 'idle' && !components.backing.connected) {
    faults.push(`${routeMode} route has no backing source`);
  }
  if (robotRoute && !components.robotSource.connected) {
    faults.push('robot route has no source page');
  }

  const warnings: string[] = [];
  if (robotRoute && components.robotSource.connected && !components.player.offsetFresh) {
    warnings.push('robot player delta is stale; alignment fell back to the network estimate');
  }
  if (components.calibration.stale) {
    warnings.push('timing calibration no longer matches the current capture');
  }

  const idle = !components.backing.connected
    && !components.mic.connected
    && !components.robotSource.connected;
  const state: RemoteStatusState = faults.length > 0
    ? 'fault'
    : idle
      ? 'idle'
      : warnings.length > 0
        ? 'degraded'
        : 'live';

  return {
    ok: faults.length === 0,
    state,
    faults,
    warnings,
  };
}
