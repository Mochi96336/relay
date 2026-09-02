import type { PcmFrame } from './pcm-frame.js';

type RelayAudioUplinkCoordinatorOptions<TSocket> = {
  isMicPublisher(socket: TSocket): boolean;
  receiveMic(socket: TSocket, data: Buffer, nowMs: number): void;
  isBackingActive(socket: TSocket): boolean;
  decodeBacking(data: Buffer): PcmFrame;
  backingGeneration(): number | null;
  now(): number;
  noteBackingFrame(socket: TSocket, nowMs: number): void;
  ingestBacking(frame: PcmFrame, nowMs: number): {
    samples: Int16Array;
    start: number;
  };
  onBackingCaptureRestarted(): void;
  noteRobotTransitionBackingFrame(
    frame: PcmFrame,
    samples: Int16Array,
    start: number,
    nowMs: number,
  ): void;
  mappedContentBackingStart(start: number, nowMs: number): number | null;
  feedContentBackingEvidence(samples: Int16Array, start: number, nowMs: number): void;
};

/**
 * Routes binary audio uplinks and preserves the established Backing ingest
 * ordering. Runtime ownership, capture-restart policy, calibration, timing,
 * Take quality and broadcasts remain callbacks supplied by the server root.
 */
export function createRelayAudioUplinkCoordinator<TSocket>(
  options: RelayAudioUplinkCoordinatorOptions<TSocket>,
) {
  return {
    handle(socket: TSocket, data: Buffer) {
      if (options.isMicPublisher(socket)) {
        options.receiveMic(socket, data, options.now());
        return 'mic' as const;
      }

      if (!options.isBackingActive(socket)) return null;

      const frame = options.decodeBacking(data);
      const previousGeneration = options.backingGeneration();
      const nowMs = options.now();
      options.noteBackingFrame(socket, nowMs);
      const { samples, start } = options.ingestBacking(frame, nowMs);
      if (
        previousGeneration !== null
        && options.backingGeneration() !== previousGeneration
      ) {
        options.onBackingCaptureRestarted();
      }

      options.noteRobotTransitionBackingFrame(frame, samples, start, nowMs);
      const contentTimingStart = options.mappedContentBackingStart(start, nowMs);
      if (contentTimingStart !== null) {
        options.feedContentBackingEvidence(samples, contentTimingStart, nowMs);
      }
      return 'backing' as const;
    },
  } as const;
}
