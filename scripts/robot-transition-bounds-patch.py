from pathlib import Path

path = Path('src/server.ts')
text = path.read_text()


def replace_once(old: str, new: str):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, found {count}: {old[:140]!r}')
    text = text.replace(old, new, 1)


replace_once(
"""import { RobotPlayerOffsetTracker } from './robot-player-offset.js';
import { RobotContentTimelineMapper } from './robot-content-timeline.js';
import {
  compareRobotContentHypothesesInWorker,
  estimateRobotContentRawLagInWorker,
} from './robot-content-transition-worker-client.js';
""",
"""import { RobotPlayerOffsetTracker } from './robot-player-offset.js';
import { RobotContentTimelineMapper } from './robot-content-timeline.js';
import {
  beginRobotContentTransitionWorker,
  carryOrCreateRobotContentTransitionBounds,
  noteRobotContentTransitionVerdict,
  noteRobotContentTransitionWorkerFailure,
  robotContentTransitionBoundsStatus,
  sweepRobotContentTransitionBounds,
  type RobotContentTransitionBounds,
} from './robot-content-transition-bounds.js';
import {
  compareRobotContentHypothesesInWorker,
  estimateRobotContentRawLagInWorker,
} from './robot-content-transition-worker-client.js';
""")

replace_once(
"""const ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES = Math.round(MIX_SAMPLE_RATE * 3);
const ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES = Math.round(MIX_SAMPLE_RATE * 0.65);
type RobotContentTransitionChunk = { start: number; samples: Int16Array };
""",
"""const ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES = Math.round(MIX_SAMPLE_RATE * 3);
const ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES = Math.round(MIX_SAMPLE_RATE * 0.65);
const ROBOT_CONTENT_TRANSITION_LIFETIME_MS = envMs(
  'RELAY_ROBOT_CONTENT_TRANSITION_LIFETIME_MS',
  15_000,
);
const ROBOT_CONTENT_TRANSITION_MAX_WINDOWS = envPositiveInt(
  'RELAY_ROBOT_CONTENT_TRANSITION_MAX_WINDOWS',
  12,
);
const ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES = envPositiveInt(
  'RELAY_ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES',
  3,
);
const ROBOT_CONTENT_TRANSITION_BOUNDS_CONFIG = {
  lifetimeMs: ROBOT_CONTENT_TRANSITION_LIFETIME_MS,
  maxWindows: ROBOT_CONTENT_TRANSITION_MAX_WINDOWS,
  maxWorkerFailures: ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES,
};
type RobotContentTransitionChunk = { start: number; samples: Int16Array };
""")

replace_once(
"""  nextWindowStart: number | null;
  analysisPending: boolean;
  discardWorkingEvidenceOnCommit: boolean;
""",
"""  nextWindowStart: number | null;
  analysisPending: boolean;
  bounds: RobotContentTransitionBounds;
  degradedHandled: boolean;
  discardWorkingEvidenceOnCommit: boolean;
""")

replace_once(
"""function clearRobotContentTransition() {
  robotContentTransitionRevision += 1;
  robotContentTransitionAbortController?.abort();
  robotContentTransitionAbortController = null;
  robotContentTransition = null;
}

function clearRobotBackingBoundaryRequest() {
""",
"""function clearRobotContentTransition() {
  robotContentTransitionRevision += 1;
  robotContentTransitionAbortController?.abort();
  robotContentTransitionAbortController = null;
  robotContentTransition = null;
}

function robotContentTransitionStatus(nowMs = performance.now()) {
  const state = robotContentTransition;
  if (state === null) return { state: 'idle' as const, quarantined: false };
  return {
    ...robotContentTransitionBoundsStatus(state.bounds, nowMs),
    quarantined: true,
  };
}

function settleDegradedRobotContentTransition(
  state: RobotContentTransitionState,
  nowMs = performance.now(),
) {
  if (
    robotContentTransition !== state
    || state.bounds.phase !== 'degraded'
    || state.degradedHandled
  ) return false;

  state.degradedHandled = true;
  pendingRobotBackingBoundary = null;
  robotContentTransitionAbortController?.abort();
  robotContentTransitionAbortController = null;
  state.analysisPending = false;
  state.discardWorkingEvidenceOnCommit = true;
  state.nextWindowStart = null;
  state.confirmedPreRanges = [];
  state.chunks = [];
  console.warn(
    '[robot-content-transition] degraded fail-closed:'
    + ` reason=${state.bounds.degradedReason ?? 'unknown'}`
    + ` windows=${state.bounds.windowsStarted}/${state.bounds.maxWindows}`
    + ` workerFailures=${state.bounds.workerFailures}/${state.bounds.maxWorkerFailures}`
    + ` ageMs=${Math.max(0, Math.round(nowMs - state.bounds.startedAtMs))}`,
  );
  broadcastJson(timingCalibrationStatusPayload());
  return true;
}

function sweepRobotContentTransition(nowMs: number) {
  const state = robotContentTransition;
  if (state === null || state.bounds.phase === 'degraded') return false;
  if (!sweepRobotContentTransitionBounds(state.bounds, nowMs)) return false;
  return settleDegradedRobotContentTransition(state, nowMs);
}

function clearRobotBackingBoundaryRequest() {
""")

replace_once(
"""  referenceDeltaMs: number,
  context: CalibrationContext,
) {
""",
"""  referenceDeltaMs: number,
  context: CalibrationContext,
  nowMs = performance.now(),
) {
""")

replace_once(
"""  const compatiblePrevious = previous !== null
    && robotTransitionContextMatches(previous.context, context)
""",
"""  const compatiblePrevious = previous !== null
    && previous.bounds.phase === 'verifying'
    && robotTransitionContextMatches(previous.context, context)
""")

replace_once(
"""    nextWindowStart: carriedNextWindowStart,
    analysisPending: false,
    discardWorkingEvidenceOnCommit: carriedDiscardWorkingEvidence,
""",
"""    nextWindowStart: carriedNextWindowStart,
    analysisPending: false,
    bounds: carryOrCreateRobotContentTransitionBounds(
      compatiblePrevious?.bounds ?? null,
      nowMs,
      ROBOT_CONTENT_TRANSITION_BOUNDS_CONFIG,
    ),
    degradedHandled: false,
    discardWorkingEvidenceOnCommit: carriedDiscardWorkingEvidence,
""")

replace_once(
"""  const controller = new AbortController();
  robotContentTransitionAbortController = controller;
  state.analysisPending = true;
  void estimateRobotContentRawLagInWorker(
""",
"""  if (!beginRobotContentTransitionWorker(state.bounds, 'anchor', nowMs)) {
    settleDegradedRobotContentTransition(state, nowMs);
    return;
  }
  const controller = new AbortController();
  robotContentTransitionAbortController = controller;
  state.analysisPending = true;
  void estimateRobotContentRawLagInWorker(
""")

replace_once(
"""  ).then((anchor) => {
    if (robotContentTransition !== state || state.revision !== robotContentTransitionRevision) return;
    state.analysisPending = false;
    robotContentTransitionAbortController = null;
    if (anchor === null) return;
    state.preRawLagMs = anchor.rawLagMs + preDeltaMs - referenceDeltaMs;
    state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;
    maybeAnalyzeRobotContentTransition();
  }, () => {
    if (robotContentTransition !== state) return;
    state.analysisPending = false;
    robotContentTransitionAbortController = null;
  });
}

function reconcileRobotContentTransitionWithFreshDelta(
  context: CalibrationContext,
) {
""",
"""  ).then((anchor) => {
    if (robotContentTransition !== state || state.revision !== robotContentTransitionRevision) return;
    state.analysisPending = false;
    robotContentTransitionAbortController = null;
    const completedAt = performance.now();
    if (sweepRobotContentTransitionBounds(state.bounds, completedAt)) {
      settleDegradedRobotContentTransition(state, completedAt);
      return;
    }
    if (anchor === null) return;
    state.preRawLagMs = anchor.rawLagMs + preDeltaMs - referenceDeltaMs;
    state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;
    maybeAnalyzeRobotContentTransition(completedAt);
  }, () => {
    if (robotContentTransition !== state || state.bounds.phase === 'degraded') return;
    state.analysisPending = false;
    robotContentTransitionAbortController = null;
    const failedAt = performance.now();
    noteRobotContentTransitionWorkerFailure(state.bounds, 'anchor', failedAt);
    if (state.bounds.phase === 'degraded') {
      settleDegradedRobotContentTransition(state, failedAt);
    }
  });
}

function reconcileRobotContentTransitionWithFreshDelta(
  context: CalibrationContext,
  nowMs = performance.now(),
) {
""")

replace_once(
"""  if (
    state === null
    || committedDeltaMs === null
""",
"""  if (
    state === null
    || state.bounds.phase === 'degraded'
    || committedDeltaMs === null
""")

replace_once(
"""    referenceDeltaMs,
    context,
  );
  return robotContentTransition !== null;
""",
"""    referenceDeltaMs,
    context,
    nowMs,
  );
  return robotContentTransition !== null;
""")

replace_once(
"""function commitRobotContentTransition(
  state: RobotContentTransitionState,
  boundarySample: number,
  nowMs: number,
) {
  if (!robotContentTimeline.noteBackingBoundary(boundarySample, state.context, nowMs)) return false;
""",
"""function commitRobotContentTransition(
  state: RobotContentTransitionState,
  boundarySample: number,
  nowMs: number,
) {
  if (state.bounds.phase !== 'verifying') return false;
  if (!robotContentTimeline.noteBackingBoundary(boundarySample, state.context, nowMs)) return false;
""")

replace_once(
"""    state === null
    || state.analysisPending
    || state.preRawLagMs === null
""",
"""    state === null
    || state.bounds.phase !== 'verifying'
    || state.analysisPending
    || state.preRawLagMs === null
""")

replace_once(
"""  const backingWindow = session.readBacking(start, ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES);
  const preMicWindow = session.readMic(preMicStart, ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES);
  const postMicWindow = session.readMic(postMicStart, ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES);
  const controller = new AbortController();
""",
"""  if (!beginRobotContentTransitionWorker(state.bounds, 'compare', nowMs)) {
    settleDegradedRobotContentTransition(state, nowMs);
    return;
  }

  const backingWindow = session.readBacking(start, ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES);
  const preMicWindow = session.readMic(preMicStart, ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES);
  const postMicWindow = session.readMic(postMicStart, ROBOT_CONTENT_TRANSITION_WINDOW_SAMPLES);
  const controller = new AbortController();
""")

replace_once(
"""    state.analysisPending = false;
    robotContentTransitionAbortController = null;

    const verdictDeltaMs = comparison.verdict === 'pre'
""",
"""    state.analysisPending = false;
    robotContentTransitionAbortController = null;
    const completedAt = performance.now();
    if (sweepRobotContentTransitionBounds(state.bounds, completedAt)) {
      settleDegradedRobotContentTransition(state, completedAt);
      return;
    }
    noteRobotContentTransitionVerdict(state.bounds, comparison.verdict);

    const verdictDeltaMs = comparison.verdict === 'pre'
""")

replace_once(
"""      && commitRobotContentTransition(state, start, performance.now())
""",
"""      && commitRobotContentTransition(state, start, completedAt)
""")

replace_once(
"""    state.nextWindowStart = end;
    maybeAnalyzeRobotContentTransition();
  }, () => {
    if (robotContentTransition !== state) return;
    state.analysisPending = false;
    robotContentTransitionAbortController = null;
    // Worker failure grants no mapping. Skip this evidence window and keep the
    // transition quarantined so a later independent window can still prove it.
    state.discardWorkingEvidenceOnCommit = true;
    state.nextWindowStart = end;
    maybeAnalyzeRobotContentTransition();
  });
}
""",
"""    state.nextWindowStart = end;
    maybeAnalyzeRobotContentTransition(completedAt);
  }, () => {
    if (robotContentTransition !== state || state.bounds.phase === 'degraded') return;
    state.analysisPending = false;
    robotContentTransitionAbortController = null;
    const failedAt = performance.now();
    // Worker failure grants no mapping. Skip this evidence window and keep the
    // transition quarantined only while the explicit retry budget remains.
    state.discardWorkingEvidenceOnCommit = true;
    noteRobotContentTransitionWorkerFailure(state.bounds, 'compare', failedAt);
    if (state.bounds.phase === 'degraded') {
      settleDegradedRobotContentTransition(state, failedAt);
      return;
    }
    state.nextWindowStart = end;
    maybeAnalyzeRobotContentTransition(failedAt);
  });
}
""")

replace_once(
"""  if (
    state === null
    || state.transportFrontierCaptureSample === null
""",
"""  if (
    state === null
    || state.bounds.phase !== 'verifying'
    || state.transportFrontierCaptureSample === null
""")

replace_once(
"""  if (!robotContentTimeline.needsBackingBoundary(context)) return false;
  if (!reconcileRobotContentTransitionWithFreshDelta(context)) return false;
""",
"""  if (!robotContentTimeline.needsBackingBoundary(context)) return false;
  if (!reconcileRobotContentTransitionWithFreshDelta(context, nowMs)) return false;
""")

replace_once(
"""    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    fallbackNetworkMs: alignment.networkCompensationMs,
""",
"""    robotDeltaFresh: robotDeltaIsFresh(nowMs),
    robotContentTransition: robotContentTransitionStatus(nowMs),
    fallbackNetworkMs: alignment.networkCompensationMs,
""")

replace_once(
"""  maybeReapplyBootCalibration(nowMs);
  maybeAutoCalibrate(nowMs);
""",
"""  maybeReapplyBootCalibration(nowMs);
  sweepRobotContentTransition(nowMs);
  maybeAutoCalibrate(nowMs);
""")

replace_once(
"""          referenceDeltaMs,
          context,
        );
""",
"""          referenceDeltaMs,
          context,
          nowMs,
        );
""")

path.write_text(text)
