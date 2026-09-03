export type RelayRobotContentTransitionCommitChunk = {
  start: number;
  samples: Int16Array;
};

export type RelayRobotContentTransitionCommitPlan<TContext> = {
  context: TContext;
  boundarySample: number;
  discardWorkingEvidence: boolean;
  confirmedPreChunks: RelayRobotContentTransitionCommitChunk[];
  postChunks: RelayRobotContentTransitionCommitChunk[];
};

export type RelayRobotContentTransitionCommitDependencies<TContext> = {
  noteBackingBoundary: (boundarySample: number, context: TContext, nowMs: number) => boolean;
  restartWorkingEvidence: (nowMs: number) => void;
  contentValidationCollecting: () => boolean;
  cancelContentValidation: (nowMs: number) => void;
  feedBackingEvidence: (samples: Int16Array, start: number, nowMs: number) => void;
  mapBackingStart: (start: number, context: TContext, nowMs: number) => number | null;
};

/**
 * Orders the cross-domain effects after Robot content-transition analysis has
 * already produced a commit plan. Timeline acceptance, calibration state,
 * validation state, mapping and evidence ingestion remain authoritative behind
 * the injected callbacks.
 */
export function createRelayRobotContentTransitionCommitCoordinator<TContext>(
  dependencies: RelayRobotContentTransitionCommitDependencies<TContext>,
) {
  return {
    commit(plan: RelayRobotContentTransitionCommitPlan<TContext>, nowMs: number) {
      if (!dependencies.noteBackingBoundary(plan.boundarySample, plan.context, nowMs)) return false;

      if (plan.discardWorkingEvidence) {
        dependencies.restartWorkingEvidence(nowMs);
        if (dependencies.contentValidationCollecting()) {
          dependencies.cancelContentValidation(nowMs);
        }
      }

      for (const chunk of plan.confirmedPreChunks) {
        dependencies.feedBackingEvidence(chunk.samples, chunk.start, nowMs);
      }
      for (const chunk of plan.postChunks) {
        const mapped = dependencies.mapBackingStart(chunk.start, plan.context, nowMs);
        if (mapped !== null) dependencies.feedBackingEvidence(chunk.samples, mapped, nowMs);
      }
      return true;
    },
  };
}
