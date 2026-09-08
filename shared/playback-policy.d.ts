export type PlaybackLeaderHealth = 'unknown' | 'missing' | 'disconnected' | 'stale' | 'healthy';

export const LEADER_HOLD_GRACE_MS: number;

export function playbackLeaderHealth(timeline: unknown): PlaybackLeaderHealth;
export function leaderHolding(timeline: unknown): boolean;
export function canRecoverPlayback(input: { role: unknown; timeline: unknown }): boolean;
export function canChangeRoomSong(input: {
  role: unknown;
  timeline: unknown;
  isMicOwner: unknown;
  isMicFree: unknown;
}): boolean;
export function shouldForceMuteListen(input: { role: unknown; timeline: unknown }): boolean;
