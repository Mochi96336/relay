import { performance } from 'node:perf_hooks';

import type { TakeFrameBoundary } from './take-boundary.js';
import type { TakeController } from './take-controller.js';
import type { TakeTimingAtStart } from './take-quality.js';
import type { TakeSongSnapshot } from './take-session.js';
import type { TakeStartBlockReason } from './take-start-policy.js';

type ParticipantSocket = { participantId?: string };
type TakeAdmission = {
  canStartTake: boolean;
  startTakeBlockedReason: TakeStartBlockReason | null;
};

type TakeCommandOptions<TSocket extends ParticipantSocket> = {
  controller: Pick<TakeController, 'start' | 'stop' | 'noteTimingAtStart'>;
  admission: (nowMs: number) => TakeAdmission;
  frameBoundary: (nowMs: number) => TakeFrameBoundary;
  songAt: (nowMs: number) => TakeSongSnapshot;
  timingAtStart: (nowMs: number) => TakeTimingAtStart;
  /** Only an admitted recording may stand down background calibration. */
  onStarted: (nowMs: number) => void;
  send: (socket: TSocket, message: Record<string, unknown>) => void;
  clock?: { wallTime: () => number; monotonicTime: () => number };
};

const TAKE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Recording commands form one synchronous transaction: admit, choose the next
 * complete mix frame, commit the recording, then stand down background timing.
 * Wall time is shifted by the same frame-quantization delta as the sample clock.
 * The controller owns recording/storage; this boundary owns command ordering.
 */
export function createTakeCommandHandlers<TSocket extends ParticipantSocket>(options: TakeCommandOptions<TSocket>) {
  const clock = options.clock ?? { wallTime: Date.now, monotonicTime: () => performance.now() };

  function reject(socket: TSocket, command: 'start' | 'stop', reason: string) {
    options.send(socket, { type: 'take-command-rejected', command, reason });
  }

  return {
    startTake(socket: TSocket) {
      const participantId = socket.participantId;
      if (!participantId) {
        reject(socket, 'start', 'participant-required');
        return;
      }
      const wallTimeMs = clock.wallTime();
      const nowMs = clock.monotonicTime();
      const admission = options.admission(nowMs);
      if (!admission.canStartTake) {
        reject(socket, 'start', admission.startTakeBlockedReason ?? 'product-state-invalid');
        return;
      }

      const boundary = options.frameBoundary(nowMs);
      const result = options.controller.start(
        participantId,
        options.songAt(boundary.atMs),
        boundary.position,
        wallTimeMs + (boundary.atMs - nowMs),
      );
      if (!result.ok) {
        reject(socket, 'start', result.reason);
        return;
      }

      options.controller.noteTimingAtStart(options.timingAtStart(nowMs));
      options.onStarted(nowMs);
      options.send(socket, { type: 'take-command-accepted', command: 'start', takeId: result.takeId });
    },

    stopTake(socket: TSocket, payload: Record<string, unknown>) {
      const participantId = socket.participantId;
      if (!participantId) {
        reject(socket, 'stop', 'participant-required');
        return;
      }
      const takeId = typeof payload.takeId === 'string' ? payload.takeId.trim() : '';
      if (!TAKE_ID_PATTERN.test(takeId)) {
        reject(socket, 'stop', 'invalid-take-id');
        return;
      }

      const wallTimeMs = clock.wallTime();
      const nowMs = clock.monotonicTime();
      const boundary = options.frameBoundary(nowMs);
      const result = options.controller.stop(
        takeId,
        participantId,
        boundary.position,
        'user',
        wallTimeMs + (boundary.atMs - nowMs),
      );
      if (!result.ok) {
        reject(socket, 'stop', result.reason);
        return;
      }
      options.send(socket, { type: 'take-command-accepted', command: 'stop', takeId, duplicate: result.duplicate });
    },
  };
}
