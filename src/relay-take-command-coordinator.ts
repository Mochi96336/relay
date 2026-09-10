export type RelayTakeBoundary<TPosition> = {
  atMs: number;
  position: TPosition;
};

export type RelayTakeStartResult =
  | { ok: true; takeId: string }
  | { ok: false; reason: string };

export type RelayTakeStopResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: string };

export type RelayTakeCommandDependencies<TSocket, TPosition, TSong> = {
  frameBoundary: (nowMs: number) => RelayTakeBoundary<TPosition>;
  songSnapshot: (atMs: number) => TSong;
  cancelActiveContentValidation: (nowMs: number) => boolean;
  /** Stands a background content measurement down. True when one was running. */
  standDownContentCalibration: () => boolean;
  reportTimingStatus: () => void;
  startTake: (
    participantId: string,
    song: TSong,
    position: TPosition,
    wallClockMs: number,
  ) => RelayTakeStartResult;
  stopTake: (
    takeId: string,
    participantId: string,
    position: TPosition,
    reason: 'user',
    wallClockMs: number,
  ) => RelayTakeStopResult;
  reject: (socket: TSocket, command: 'start' | 'stop', reason: string) => void;
  acceptStart: (socket: TSocket, takeId: string) => void;
  acceptStop: (socket: TSocket, takeId: string, duplicate: boolean) => void;
};

export function createRelayTakeCommandCoordinator<TSocket, TPosition, TSong>(
  dependencies: RelayTakeCommandDependencies<TSocket, TPosition, TSong>,
) {
  return {
    start(input: {
      socket: TSocket;
      participantId: string;
      commandWallClockMs: number;
      nowMs: number;
    }) {
      const boundary = dependencies.frameBoundary(input.nowMs);
      const song = dependencies.songSnapshot(boundary.atMs);

      const result = dependencies.startTake(
        input.participantId,
        song,
        boundary.position,
        input.commandWallClockMs + (boundary.atMs - input.nowMs),
      );
      if (!result.ok) {
        dependencies.reject(input.socket, 'start', result.reason);
        return false;
      }

      // Background timing work may only be stood down after Take admission.
      // A rejected command must not discard either a validator confirmation
      // window or content-calibration evidence the room had already gathered.
      // `startTake` is synchronous, so no analysis callback can interleave
      // between admission and these stand-down effects.
      if (dependencies.cancelActiveContentValidation(input.nowMs)) {
        dependencies.reportTimingStatus();
      }

      if (dependencies.standDownContentCalibration()) {
        dependencies.reportTimingStatus();
      }

      dependencies.acceptStart(input.socket, result.takeId);
      return true;
    },

    stop(input: {
      socket: TSocket;
      participantId: string;
      takeId: string;
      commandWallClockMs: number;
      nowMs: number;
    }) {
      const boundary = dependencies.frameBoundary(input.nowMs);
      const result = dependencies.stopTake(
        input.takeId,
        input.participantId,
        boundary.position,
        'user',
        input.commandWallClockMs + (boundary.atMs - input.nowMs),
      );
      if (!result.ok) {
        dependencies.reject(input.socket, 'stop', result.reason);
        return false;
      }

      dependencies.acceptStop(input.socket, input.takeId, result.duplicate);
      return true;
    },
  };
}
