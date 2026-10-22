export type RoomMicState = 'free' | 'starting' | 'live' | 'interrupted' | 'reconnecting';

export type RoomMicFacts = {
  ownerId: string | null;
  connected: boolean;
  flowObserved: boolean;
  startupTimedOut?: boolean;
  streaming: boolean;
};

export function deriveRoomMicState(facts: RoomMicFacts): RoomMicState {
  if (facts.ownerId === null) return 'free';
  if (!facts.connected) return 'reconnecting';
  if (!facts.flowObserved) return facts.startupTimedOut ? 'interrupted' : 'starting';
  if (facts.streaming) return 'live';
  return 'interrupted';
}

export type RoomSongState = 'empty' | 'ready' | 'playing' | 'handoff' | 'unavailable';

export type RoomSongFacts = {
  videoId: string | null;
  connected: boolean;
  /** How long since the room clock last accepted a report. */
  clockAgeMs: number;
  state: number | null;
  handoffState: string;
};

/**
 * Product-facing clock continuity is intentionally slower than SongSession's
 * short alignment/authority freshness window. A browser can miss several
 * telemetry samples while dimmed, backgrounded, or rebuffering without the
 * room becoming meaningfully unavailable to the singer.
 */
export const SONG_CLOCK_LOST_MS = 6_000;
/** A substantially longer moving-clock gap blocks new synchronized Takes. */
export const SONG_CLOCK_BLOCKING_MS = 15_000;

export function roomSongClockLost(facts: RoomSongFacts): boolean {
  // Only moving media needs a progressing clock. A paused/cued/ended song or
  // a handoff in preparation is not failed playback when its page stops reporting.
  if (![1, 3].includes(facts.state ?? -1) || facts.handoffState !== 'idle') return false;
  return !facts.connected && facts.clockAgeMs > SONG_CLOCK_LOST_MS;
}

export function deriveRoomSongState(facts: RoomSongFacts): RoomSongState {
  if (facts.videoId === null) return 'empty';
  if (facts.handoffState !== 'idle') return 'handoff';
  if (roomSongClockLost(facts)) return 'unavailable';
  if (facts.state === 1) return 'playing';
  return 'ready';
}

export function roomSongClockSeverity(
  facts: RoomSongFacts,
  performanceActive: boolean,
): 'warning' | 'critical' | null {
  if (facts.videoId === null || !roomSongClockLost(facts)) return null;
  return performanceActive && facts.clockAgeMs > SONG_CLOCK_BLOCKING_MS
    ? 'critical'
    : 'warning';
}
