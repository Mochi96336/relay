export type RelaySourceSeekTransactionInput<TContext> = {
  mappedFollowerCorrection: boolean;
  fromMediaTime: number;
  toMediaTime: number;
  preDeltaMs: number | null;
  referenceDeltaMs: number | null;
  context: TContext;
  nowMs: number;
};

export type RelaySourceSeekTransactionDependencies<TContext> = {
  resetPlayerOffset: () => void;
  beginContentTransition: (
    fromMediaTime: number,
    toMediaTime: number,
    preDeltaMs: number,
    referenceDeltaMs: number,
    context: TContext,
    nowMs: number,
  ) => void;
  syncAppliedCalibration: () => void;
  reportSourceStatus: () => void;
  reportTimingStatus: () => void;
  /**
   * The server's single Robot mapping revocation. A destructive seek is exactly
   * that event, so it must not re-spell the teardown: a step added to the
   * transaction has to reach this path too.
   */
  revokeContentMapping: (reason: string) => void;
};

/**
 * Orders the lifecycle effects after a Source seek has already passed
 * infrastructure authority and the mapping runtimes have classified whether
 * it is a concrete follower correction. Classification and mapping authority
 * deliberately remain in server.ts / the existing runtimes.
 */
export function createRelaySourceSeekTransactionCoordinator<TContext>(
  dependencies: RelaySourceSeekTransactionDependencies<TContext>,
) {
  return {
    handle(input: RelaySourceSeekTransactionInput<TContext>) {
      dependencies.resetPlayerOffset();

      if (input.mappedFollowerCorrection) {
        if (input.preDeltaMs !== null && input.referenceDeltaMs !== null) {
          dependencies.beginContentTransition(
            input.fromMediaTime,
            input.toMediaTime,
            input.preDeltaMs,
            input.referenceDeltaMs,
            input.context,
            input.nowMs,
          );
        }
        dependencies.syncAppliedCalibration();
        dependencies.reportSourceStatus();
        dependencies.reportTimingStatus();
        return 'mapped-follower-correction' as const;
      }

      dependencies.revokeContentMapping(
        'The desktop player seeked during calibration. Start calibration again.',
      );
      return 'destructive-seek' as const;
    },
  };
}
