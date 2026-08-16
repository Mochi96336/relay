export type RoomSongCommandBody =
  | { action: 'load'; videoId: string; positionSeconds: number }
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'seek'; positionSeconds: number }
  | { action: 'rate'; playbackRate: number };

export type RoomSongCommandRequest = {
  commandId: string;
  expectedRevision: number;
  body: RoomSongCommandBody;
};

export type RoomSongCommandParseResult =
  | { ok: true; request: RoomSongCommandRequest }
  | { ok: false; reason: 'invalid-command-id' | 'invalid-revision' | 'invalid-command' };

const COMMAND_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_POSITION_SECONDS = 1_000_000;

function finitePosition(value: unknown) {
  const position = Number(value);
  return Number.isFinite(position) && position >= 0 && position <= MAX_POSITION_SECONDS
    ? position
    : null;
}

function finiteRate(value: unknown) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0.25 && rate <= 4
    ? rate
    : null;
}

/**
 * Parse the public room-song command envelope without trusting any client
 * identity or playback target. Those are attached by the server from the
 * authenticated websocket transport after this shape check succeeds.
 */
export function parseRoomSongCommand(payload: Record<string, unknown>): RoomSongCommandParseResult {
  const commandId = typeof payload.commandId === 'string' ? payload.commandId.trim() : '';
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    return { ok: false, reason: 'invalid-command-id' };
  }

  const expectedRevision = Number(payload.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, reason: 'invalid-revision' };
  }

  const action = payload.action;
  if (action === 'load') {
    const videoId = typeof payload.videoId === 'string' ? payload.videoId.trim() : '';
    const positionSeconds = payload.positionSeconds === undefined
      ? 0
      : finitePosition(payload.positionSeconds);
    if (!VIDEO_ID_PATTERN.test(videoId) || positionSeconds === null) {
      return { ok: false, reason: 'invalid-command' };
    }
    return {
      ok: true,
      request: {
        commandId,
        expectedRevision,
        body: { action, videoId, positionSeconds },
      },
    };
  }

  if (action === 'play' || action === 'pause') {
    return {
      ok: true,
      request: {
        commandId,
        expectedRevision,
        body: { action },
      },
    };
  }

  if (action === 'seek') {
    const positionSeconds = finitePosition(payload.positionSeconds);
    if (positionSeconds === null) return { ok: false, reason: 'invalid-command' };
    return {
      ok: true,
      request: {
        commandId,
        expectedRevision,
        body: { action, positionSeconds },
      },
    };
  }

  if (action === 'rate') {
    const playbackRate = finiteRate(payload.playbackRate);
    if (playbackRate === null) return { ok: false, reason: 'invalid-command' };
    return {
      ok: true,
      request: {
        commandId,
        expectedRevision,
        body: { action, playbackRate },
      },
    };
  }

  return { ok: false, reason: 'invalid-command' };
}
