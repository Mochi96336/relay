import assert from 'node:assert/strict';

import { parseRoomSongCommand } from '../../src/room-song-command.js';
import { VIDEO, youtubeTelemetry } from './youtube-telemetry.js';

// Fixtures several Room Song command tests share: one playback tab and one video.
export const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };

export { VIDEO };

export function command(commandId: string, expectedRevision: number, action: string, extra: Record<string, unknown> = {}) {
  const parsed = parseRoomSongCommand({ commandId, expectedRevision, action, ...extra });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid room song command fixture');
  return parsed.request;
}

export function room(overrides: Record<string, unknown> = {}) {
  return {
    type: 'youtube-timeline-status',
    videoId: VIDEO,
    state: 2,
    serverTime: 10,
    youtubeTime: 10,
    ageMs: 0,
    playbackRate: 1,
    playbackLeaderParticipantId: A.participantId,
    playbackTransportId: A.transportId,
    playbackGeneration: A.generation,
    connected: true,
    leaderConnected: true,
    leaderFresh: true,
    handoffState: 'idle',
    ...overrides,
  };
}

export function telemetry(overrides: Record<string, unknown> = {}) {
  return youtubeTelemetry({ timelineDeltaSeconds: 0, ...overrides });
}
