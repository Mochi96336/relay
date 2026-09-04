import { performance } from 'node:perf_hooks';

import {
  beginRobotContentTransitionWorker,
  carryOrCreateRobotContentTransitionBounds,
  noteRobotContentTransitionVerdict,
  noteRobotContentTransitionWorkerFailure,
  robotContentTransitionBoundsStatus,
  sweepRobotContentTransitionBounds,
  type RobotContentTransitionBounds,
  type RobotContentTransitionBoundsConfig,
} from './robot-content-transition-bounds.js';
import {
  compareRobotContentHypothesesInWorker,
  estimateRobotContentRawLagInWorker,
} from './robot-content-transition-worker-client.js';
import type {
  RobotContentTransitionAnchor,
  RobotContentTransitionComparison,
} from './robot-content-transition.js';

export type RobotContentTransitionContext = {
  sessionGeneration: number;
  micGeneration: number | null;
  backingGeneration: number | null;
  sourceGeneration: number;
};

export type RobotContentTransitionChunk = {
  start: number;
  samples: Int16Array;
};

export type RobotContentTransitionCommitPlan = {
  context: RobotContentTransitionContext;
  boundarySample: number;
  discardWorkingEvidence: boolean;
  confirmedPreChunks: RobotContentTransitionChunk[];
  postChunks: RobotContentTransitionChunk[];
};

type RobotContentTransitionEvidence = {
  mic: Int16Array;
  backing: Int16Array;
};

export type RobotContentTransitionRuntimeHost = {
  context: () => RobotContentTransitionContext;
  currentDeltaMs: () => number | null;
  backingTotalSamples: () => number;
  micTotalSamples: () => number;
  readBacking: (start: number, length: number) => Int16Array;
  readMic: (start: number, length: number) => Int16Array;
  transitionEvidence: (maxSamples: number) => RobotContentTransitionEvidence | null;
  commit: (plan: RobotContentTransitionCommitPlan, nowMs: number) => boolean;
  onDegraded?: (status: ReturnType<typeof robotContentTransitionBoundsStatus>) => void;
};

export type RobotContentTransitionRuntimeOptions = {
  sampleRate: number;
  historySamples: number;
  windowSamples: number;
  maxLagMs: number;
  toleranceMs: number;
  retentionSamples: number;
  bounds: RobotContentTransitionBoundsConfig;
  host: RobotContentTransitionRuntimeHost;
  now?: () => number;
  estimateRawLag?: (
    micSamples: Int16Array,
    backingSamples: Int16Array,
    sampleRate: number,
    maxLagMs: number,
    signal?: AbortSignal,
  ) => Promise<RobotContentTransitionAnchor | null>;
  compareHypotheses?: (
    backingSamples: Int16Array,
    preMicSamples: Int16Array,
    postMicSamples: Int16Array,
    sampleRate: number,
    signal?: AbortSignal,
  ) => Promise<RobotContentTransitionComparison>;
};

export type RobotContentTransitionBeginInput = {
  fromMediaTime: number;
  toMediaTime: number;
  preDeltaMs: number;
  referenceDeltaMs: number;
  context: RobotContentTransitionContext;
  confirmedReferenceLagMs: number | null;
};

type RobotContentTransitionState = {
  revision: number;
  context: RobotContentTransitionContext;
  seekJumpMs: number;
  preDeltaMs: number;
  postDeltaMs: number;
  preShiftSamples: number;
  anchorAdjustmentMs: number;
  anchorEvidenceSamplesAttempted: number;
  preRawLagMs: number | null;
  postRawLagMs: number | null;
  transportFrontierCaptureSample: number | null;
  commitFloorSample: number | null;
  nextWindowStart: number | null;
  analysisPending: boolean;
  bounds: RobotContentTransitionBounds;
  degradedHandled: boolean;
  discardWorkingEvidenceOnCommit: boolean;
  confirmedPreRanges: Array<{ start: number; end: number }>;
  chunks: RobotContentTransitionChunk[];
};

type PendingBackingBoundary = {
  requestId: number;
  backingGeneration: number;
};

function validPositive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

function validPositiveInt(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function contextMatches(left: RobotContentTransitionContext, right: RobotContentTransitionContext) {
  return left.sessionGeneration === right.sessionGeneration
    && left.micGeneration === right.micGeneration
    && left.backingGeneration === right.backingGeneration
    && left.sourceGeneration === right.sourceGeneration;
}

export class RobotContentTransitionRuntime {
  private readonly sampleRate: number;
  private readonly historySamples: number;
  private readonly windowSamples: number;
  private readonly maxLagMs: number;
  private readonly toleranceMs: number;
  private readonly retentionSamples: number;
  private readonly boundsConfig: RobotContentTransitionBoundsConfig;
  private readonly host: RobotContentTransitionRuntimeHost;
  private readonly now: () => number;
  private readonly estimateRawLag: NonNullable<RobotContentTransitionRuntimeOptions['estimateRawLag']>;
  private readonly compareHypotheses: NonNullable<RobotContentTransitionRuntimeOptions['compareHypotheses']>;

  private revision = 0;
  private state: RobotContentTransitionState | null = null;
  private abortController: AbortController | null = null;
  private boundaryRequestId = 0;
  private pendingBoundary: PendingBackingBoundary | null = null;

  constructor(options: RobotContentTransitionRuntimeOptions) {
    this.sampleRate = validPositive(options.sampleRate, 'sampleRate');
    this.historySamples = validPositiveInt(options.historySamples, 'historySamples');
    this.windowSamples = validPositiveInt(options.windowSamples, 'windowSamples');
    this.maxLagMs = validPositive(options.maxLagMs, 'maxLagMs');
    this.toleranceMs = validPositive(options.toleranceMs, 'toleranceMs');
    this.retentionSamples = validPositive(options.retentionSamples, 'retentionSamples');
    this.boundsConfig = { ...options.bounds };
    this.host = options.host;
    this.now = options.now ?? (() => performance.now());
    this.estimateRawLag = options.estimateRawLag ?? estimateRobotContentRawLagInWorker;
    this.compareHypotheses = options.compareHypotheses ?? compareRobotContentHypothesesInWorker;
  }

  get quarantined() {
    return this.state !== null;
  }

  status(nowMs = this.now()) {
    const state = this.state;
    if (state === null) return { state: 'idle' as const, quarantined: false };
    return {
      ...robotContentTransitionBoundsStatus(state.bounds, nowMs),
      quarantined: true,
    };
  }

  clear() {
    this.revision += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.pendingBoundary = null;
    this.state = null;
  }

  clearPendingBoundary() {
    this.pendingBoundary = null;
  }

  begin(input: RobotContentTransitionBeginInput, nowMs = this.now()) {
    const seekJumpMs = (input.toMediaTime - input.fromMediaTime) * 1_000;
    const preShiftSamples = Math.round(
      ((input.preDeltaMs - input.referenceDeltaMs) * this.sampleRate) / 1_000,
    );
    const seekJumpSamples = Math.round((seekJumpMs * this.sampleRate) / 1_000);
    const previous = this.state;
    const compatiblePrevious = previous !== null
      && previous.bounds.phase === 'verifying'
      && contextMatches(previous.context, input.context)
      && previous.preShiftSamples === preShiftSamples
      && Math.round((previous.seekJumpMs * this.sampleRate) / 1_000) === seekJumpSamples
        ? previous
        : null;
    const carriedNextWindowStart = compatiblePrevious?.nextWindowStart ?? null;
    const carriedDiscardWorkingEvidence = compatiblePrevious?.discardWorkingEvidenceOnCommit ?? false;
    const carriedPreRanges = compatiblePrevious?.confirmedPreRanges.map((range) => ({ ...range })) ?? [];
    const carriedChunks = compatiblePrevious?.chunks.map((chunk) => ({
      start: chunk.start,
      samples: new Int16Array(chunk.samples),
    })) ?? [];

    this.clear();
    const state: RobotContentTransitionState = {
      revision: this.revision,
      context: { ...input.context },
      seekJumpMs,
      preDeltaMs: input.preDeltaMs,
      postDeltaMs: input.preDeltaMs + seekJumpMs,
      preShiftSamples,
      anchorAdjustmentMs: input.preDeltaMs - input.referenceDeltaMs,
      anchorEvidenceSamplesAttempted: 0,
      preRawLagMs: null,
      postRawLagMs: null,
      transportFrontierCaptureSample: null,
      commitFloorSample: null,
      nextWindowStart: carriedNextWindowStart,
      analysisPending: false,
      bounds: carryOrCreateRobotContentTransitionBounds(
        compatiblePrevious?.bounds ?? null,
        nowMs,
        this.boundsConfig,
      ),
      degradedHandled: false,
      discardWorkingEvidenceOnCommit: carriedDiscardWorkingEvidence,
      confirmedPreRanges: carriedPreRanges,
      chunks: carriedChunks,
    };
    this.state = state;

    if (input.confirmedReferenceLagMs !== null) {
      state.preRawLagMs = input.confirmedReferenceLagMs + state.anchorAdjustmentMs;
      state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;
      return;
    }

    this.maybeStartAnchor(state, nowMs);
  }

  reconcileWithFreshDelta(input: {
    context: RobotContentTransitionContext;
    committedDeltaMs: number | null;
    freshDeltaMs: number | null;
    referenceDeltaMs: number | null;
    confirmedReferenceLagMs: number | null;
  }, nowMs = this.now()) {
    const state = this.state;
    if (
      state === null
      || state.bounds.phase === 'degraded'
      || input.committedDeltaMs === null
      || input.freshDeltaMs === null
      || input.referenceDeltaMs === null
      || !contextMatches(state.context, input.context)
    ) return state?.bounds.phase !== 'degraded';

    const matchesPre = Math.abs(state.preDeltaMs - input.freshDeltaMs) <= this.toleranceMs;
    const matchesPost = Math.abs(state.postDeltaMs - input.freshDeltaMs) <= this.toleranceMs;
    if (matchesPre || matchesPost) return true;

    this.pendingBoundary = null;
    const seekJumpSeconds = (input.freshDeltaMs - input.committedDeltaMs) / 1_000;
    this.begin({
      fromMediaTime: seekJumpSeconds < 0 ? -seekJumpSeconds : 0,
      toMediaTime: seekJumpSeconds < 0 ? 0 : seekJumpSeconds,
      preDeltaMs: input.committedDeltaMs,
      referenceDeltaMs: input.referenceDeltaMs,
      context: input.context,
      confirmedReferenceLagMs: input.confirmedReferenceLagMs,
    }, nowMs);
    return this.state !== null;
  }

  requestBackingBoundary(backingGeneration: number) {
    const state = this.state;
    if (
      state === null
      || state.bounds.phase !== 'verifying'
      || state.transportFrontierCaptureSample !== null
      || this.pendingBoundary !== null
    ) return null;

    this.boundaryRequestId += 1;
    if (!Number.isSafeInteger(this.boundaryRequestId)) this.boundaryRequestId = 1;
    this.pendingBoundary = { requestId: this.boundaryRequestId, backingGeneration };
    return { ...this.pendingBoundary };
  }

  acceptBackingBoundary(input: {
    requestId: number;
    generation: number | null;
    firstSampleIndex: number;
    currentBackingGeneration: number | null;
    context: RobotContentTransitionContext;
  }) {
    const pending = this.pendingBoundary;
    if (pending === null || input.requestId !== pending.requestId) return false;

    // A matching reply consumes the request even when malformed. A later fresh
    // Robot offset may ask again; malformed transport metadata grants no map.
    this.pendingBoundary = null;
    if (
      input.generation === null
      || input.generation !== pending.backingGeneration
      || input.generation !== input.currentBackingGeneration
      || !Number.isSafeInteger(input.firstSampleIndex)
      || input.firstSampleIndex < 0
    ) return false;

    const state = this.state;
    if (
      state === null
      || state.bounds.phase !== 'verifying'
      || !contextMatches(state.context, input.context)
    ) return false;

    state.transportFrontierCaptureSample = input.firstSampleIndex;
    return true;
  }

  noteBackingFrame(input: {
    frameGeneration: number | null;
    firstSampleIndex: number | null;
    sourceSampleCount: number;
    sourceSampleRate: number | null;
    samples: Int16Array;
    start: number;
    backingTotalSamples: number;
  }, nowMs = this.now()) {
    const state = this.state;
    if (
      state === null
      || state.bounds.phase !== 'verifying'
      || state.transportFrontierCaptureSample === null
      || input.sourceSampleRate === null
      || input.firstSampleIndex === null
      || input.frameGeneration !== state.context.backingGeneration
    ) return false;

    const sourceEnd = input.firstSampleIndex + input.sourceSampleCount;
    if (sourceEnd <= state.transportFrontierCaptureSample) return false;

    const sourceOffset = Math.max(0, state.transportFrontierCaptureSample - input.firstSampleIndex);
    const sampleOffset = Math.min(
      input.samples.length,
      Math.max(0, Math.round((sourceOffset * this.sampleRate) / input.sourceSampleRate)),
    );
    if (sampleOffset >= input.samples.length) return false;

    const eligibleStart = input.start + sampleOffset;
    const eligibleSamples = new Int16Array(input.samples.subarray(sampleOffset));
    if (state.commitFloorSample === null) state.commitFloorSample = eligibleStart;
    if (state.nextWindowStart === null) state.nextWindowStart = eligibleStart;
    state.chunks.push({ start: eligibleStart, samples: eligibleSamples });

    const keepAfter = Math.max(0, input.backingTotalSamples - this.retentionSamples);
    state.chunks = state.chunks.filter((chunk) => chunk.start + chunk.samples.length > keepAfter);
    this.maybeStartAnchor(state, nowMs);
    this.maybeAnalyze(nowMs);
    return true;
  }

  noteMicProgress(nowMs = this.now()) {
    const state = this.state;
    if (state !== null) this.maybeStartAnchor(state, nowMs);
    this.maybeAnalyze(nowMs);
  }

  sweep(nowMs = this.now()) {
    const state = this.state;
    if (state === null || state.bounds.phase === 'degraded') return false;
    if (!sweepRobotContentTransitionBounds(state.bounds, nowMs)) return false;
    return this.settleDegraded(state, nowMs);
  }

  private current(state: RobotContentTransitionState) {
    return this.state === state && state.revision === this.revision;
  }

  private settleDegraded(state: RobotContentTransitionState, nowMs: number) {
    if (!this.current(state) || state.bounds.phase !== 'degraded' || state.degradedHandled) return false;
    state.degradedHandled = true;
    this.pendingBoundary = null;
    this.abortController?.abort();
    this.abortController = null;
    state.analysisPending = false;
    state.discardWorkingEvidenceOnCommit = true;
    state.nextWindowStart = null;
    state.confirmedPreRanges = [];
    state.chunks = [];
    this.host.onDegraded?.(robotContentTransitionBoundsStatus(state.bounds, nowMs));
    return true;
  }

  private transitionChunkSlices(
    state: RobotContentTransitionState,
    rangeStart: number,
    rangeEnd: number,
  ) {
    const slices: RobotContentTransitionChunk[] = [];
    for (const chunk of state.chunks) {
      const chunkEnd = chunk.start + chunk.samples.length;
      const start = Math.max(chunk.start, rangeStart);
      const end = Math.min(chunkEnd, rangeEnd);
      if (end <= start) continue;
      const offset = start - chunk.start;
      slices.push({
        start,
        samples: new Int16Array(chunk.samples.subarray(offset, offset + end - start)),
      });
    }
    return slices;
  }

  private commit(state: RobotContentTransitionState, boundarySample: number, nowMs: number) {
    if (!this.current(state) || state.bounds.phase !== 'verifying') return false;
    const discardWorkingEvidence = state.discardWorkingEvidenceOnCommit;
    const confirmedPreChunks = discardWorkingEvidence
      ? []
      : state.confirmedPreRanges.flatMap((range) => this.transitionChunkSlices(
        state,
        range.start,
        range.end,
      ).map((chunk) => ({
        start: chunk.start + state.preShiftSamples,
        samples: chunk.samples,
      })));
    const postChunks = discardWorkingEvidence
      ? []
      : this.transitionChunkSlices(state, boundarySample, Number.POSITIVE_INFINITY);

    if (!this.host.commit({
      context: { ...state.context },
      boundarySample,
      discardWorkingEvidence,
      confirmedPreChunks,
      postChunks,
    }, nowMs)) return false;

    this.abortController = null;
    this.pendingBoundary = null;
    this.state = null;
    return true;
  }

  private maybeStartAnchor(state: RobotContentTransitionState, nowMs = this.now()) {
    if (
      !this.current(state)
      || state.bounds.phase !== 'verifying'
      || state.analysisPending
      || state.preRawLagMs !== null
      || state.postRawLagMs !== null
      || !contextMatches(state.context, this.host.context())
    ) return false;

    const evidence = this.host.transitionEvidence(this.historySamples);
    if (evidence === null) return false;
    const evidenceSamples = Math.min(evidence.mic.length, evidence.backing.length);
    if (
      evidenceSamples <= this.sampleRate
      || evidenceSamples <= state.anchorEvidenceSamplesAttempted
    ) return false;

    // A null/ambiguous anchor is not terminal. More pre-seek evidence may make
    // the next bounded attempt decisive. Never rerun the worker for the exact
    // same snapshot, though: Mic/backing frame callbacks are much faster than
    // the analyser and would otherwise create an accidental worker storm.
    state.anchorEvidenceSamplesAttempted = evidenceSamples;
    if (!beginRobotContentTransitionWorker(state.bounds, 'anchor', nowMs)) {
      this.settleDegraded(state, nowMs);
      return false;
    }

    const controller = new AbortController();
    this.abortController = controller;
    state.analysisPending = true;
    void this.estimateRawLag(
      evidence.mic,
      evidence.backing,
      this.sampleRate,
      this.maxLagMs,
      controller.signal,
    ).then((anchor) => {
      if (!this.current(state)) return;
      state.analysisPending = false;
      this.abortController = null;
      const completedAt = this.now();
      if (sweepRobotContentTransitionBounds(state.bounds, completedAt)) {
        this.settleDegraded(state, completedAt);
        return;
      }
      if (anchor === null) return;
      state.preRawLagMs = anchor.rawLagMs + state.anchorAdjustmentMs;
      state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;
      this.maybeAnalyze(completedAt);
    }, () => {
      if (!this.current(state) || state.bounds.phase === 'degraded') return;
      state.analysisPending = false;
      this.abortController = null;
      const failedAt = this.now();
      if (noteRobotContentTransitionWorkerFailure(state.bounds, 'anchor', failedAt)) {
        this.settleDegraded(state, failedAt);
      }
    });
    return true;
  }

  private maybeAnalyze(nowMs = this.now()) {
    const state = this.state;
    if (
      state === null
      || state.bounds.phase !== 'verifying'
      || state.analysisPending
      || state.preRawLagMs === null
      || state.postRawLagMs === null
      || state.nextWindowStart === null
      || !contextMatches(state.context, this.host.context())
    ) return;

    const start = state.nextWindowStart;
    const end = start + this.windowSamples;
    const preMicStart = start + Math.round((state.preRawLagMs * this.sampleRate) / 1_000);
    const postMicStart = start + Math.round((state.postRawLagMs * this.sampleRate) / 1_000);
    if (preMicStart < 0 || postMicStart < 0) {
      state.nextWindowStart = end;
      return;
    }
    if (
      this.host.backingTotalSamples() < end
      || this.host.micTotalSamples() < preMicStart + this.windowSamples
      || this.host.micTotalSamples() < postMicStart + this.windowSamples
    ) return;

    if (!beginRobotContentTransitionWorker(state.bounds, 'compare', nowMs)) {
      this.settleDegraded(state, nowMs);
      return;
    }

    const backingWindow = this.host.readBacking(start, this.windowSamples);
    const preMicWindow = this.host.readMic(preMicStart, this.windowSamples);
    const postMicWindow = this.host.readMic(postMicStart, this.windowSamples);
    const controller = new AbortController();
    this.abortController = controller;
    state.analysisPending = true;

    void this.compareHypotheses(
      backingWindow,
      preMicWindow,
      postMicWindow,
      this.sampleRate,
      controller.signal,
    ).then((comparison) => {
      if (!this.current(state)) return;
      state.analysisPending = false;
      this.abortController = null;
      const completedAt = this.now();
      if (sweepRobotContentTransitionBounds(state.bounds, completedAt)) {
        this.settleDegraded(state, completedAt);
        return;
      }
      noteRobotContentTransitionVerdict(state.bounds, comparison.verdict);

      const verdictDeltaMs = comparison.verdict === 'pre'
        ? state.preDeltaMs
        : comparison.verdict === 'post'
          ? state.postDeltaMs
          : null;
      const currentDeltaMs = this.host.currentDeltaMs();
      const verdictMatchesCurrentMapping = verdictDeltaMs !== null
        && currentDeltaMs !== null
        && Math.abs(currentDeltaMs - verdictDeltaMs) <= this.toleranceMs;
      const crossedCurrentTransportFrontier = state.commitFloorSample !== null
        && start >= state.commitFloorSample;

      if (
        verdictMatchesCurrentMapping
        && crossedCurrentTransportFrontier
        && this.commit(state, start, completedAt)
      ) return;

      if (comparison.verdict === 'pre') {
        state.confirmedPreRanges.push({ start, end });
      } else {
        state.discardWorkingEvidenceOnCommit = true;
      }
      state.nextWindowStart = end;
      this.maybeAnalyze(completedAt);
    }, () => {
      if (!this.current(state) || state.bounds.phase === 'degraded') return;
      state.analysisPending = false;
      this.abortController = null;
      const failedAt = this.now();
      state.discardWorkingEvidenceOnCommit = true;
      if (noteRobotContentTransitionWorkerFailure(state.bounds, 'compare', failedAt)) {
        this.settleDegraded(state, failedAt);
        return;
      }
      state.nextWindowStart = end;
      this.maybeAnalyze(failedAt);
    });
  }
}
