import { MixBus } from './mix-bus.js';
import { MicTrack } from './mic-track.js';
import { ChoirContentPcmBuffer } from './choir-content-pcm-buffer.js';
import type { ChoirAlignmentDecision } from './choir-calibration-experiment.js';
import { ingestPcmTimeline } from './pcm-ingest.js';
import type { PcmFrame } from './pcm-frame.js';
import {
  emptyPcmTimeline, readPcmEvidence, readPcmGapMask, readPcmRange,
} from './pcm-timeline.js';

/**
 * Canonical N=2 test harness. The Mic PCM passes through the EXACT MicTrack
 * ingest/clock/read/gain/limiter/edge path now used by AudioSession N=1, then
 * the EXISTING MixBus sums one bounded group voice plus one room backing.
 *
 * Not imported by server.ts. This is not a production Choir room: it has no
 * publisher authentication, Take authority, calibrated media clock bridge,
 * or output/transport scheduling. The deliberately fixed two-slot headroom
 * is not N=1 byte-exact, which is independently guarded by AudioSession.
 */
export type CanonicalChoirSingerId = {
  participantId: string;
  songEpoch: number;
  backingGeneration: number;
  /** Trusted server-side media admission epoch, NEVER a client credential. */
  mediaEpoch: number;
};

export type CanonicalChoirSingerEvidence = {
  participantId: string;
  mediaEpoch: number;
  /** Read-head location of this frame in the singer's own session PCM. */
  readStartSample: number;
  /** Peak absolute canonical voice AFTER limiter+edge, BEFORE group headroom. */
  voicePeakAbs: number;
  gapSamples: number;
  frontierMissingSamples: number;
  unheaderedSamples: number;
  inputClippedSamples: number;
  limitedSamples: number;
  heavyLimitedSamples: number;
  /** Limiter attack overshoots its ceiling: explicit N=2 bus guard engaged. */
  limiterOvershootSamples: number;
  /** Newly arrived Mic PCM dropped after its source position was already emitted. */
  latePacketDrops: number;
  expected: boolean;
  awaitingCalibration: boolean;
  /** Newly accepted authority; live read-head may still be converging toward it. */
  calibrationSource: 'content' | 'sample-song-estimate' | 'boot-probe-estimate' | null;
  /** Value applied to this frame by the canonical 1%-per-frame MicTrack slew. */
  calibrationAppliedMs: number | null;
  calibrationTargetMs: number | null;
  /** Large Content disagreement staged without moving this audible read head. */
  reacquisitionPending: boolean;
  /** Next capture, not this one, must supply newly confirmed Content. */
  requiresFreshContent: boolean;
};

export type CanonicalChoirFrame = {
  roomStartSample: number;
  pcm: Int16Array;
  singers: CanonicalChoirSingerEvidence[];
  backingGapSamples: number;
  outputClippedSamples: number;
};

type Slot = {
  identity: CanonicalChoirSingerId;
  mic: MicTrack;
  contentHistory: ChoirContentPcmBuffer | null;
  expected: boolean;
  /** Separate entrance fade; room MixBus cannot detect an additional Mic. */
  joinGain: number;
  latePacketDrops: number;
  awaitingCalibration: boolean;
  pendingReacquisition: { revision: number; targetMs: number } | null;
  requiresFreshContent: boolean;
  /** Authority for the currently admitted capture only; never re-used on rebind. */
  authority: {
    source: 'content' | 'sample-song-estimate' | 'boot-probe-estimate';
    firstAdvanceMs: number;
    revision: number;
    captureGeneration: number | null;
    sourceRate: number | null;
  } | null;
};

type RoomConfig = {
  sampleRate: number;
  frameMs: number;
  prebufferMs: number;
  retentionMs: number;
  songEpoch: number;
  backingGeneration: number;
  backingGain?: number;
  /** Separate six-second Content evidence cache; does not alter mixer retention. */
  contentHistoryMs?: number;
};

export class CanonicalChoirMixExperiment {
  private readonly slots = new Map<string, Slot>();
  private readonly backing = emptyPcmTimeline();
  private readonly backingContentHistory: ChoirContentPcmBuffer | null;
  private readonly contentHistoryMs: number | null;
  private backingCaptureOriginSample: number | null = null;
  private readonly bus: MixBus;
  private readonly frameSamples: number;
  private readonly micOptions: ConstructorParameters<typeof MicTrack>[0];
  private readonly sampleRate: number;
  private readonly voiceCeiling: number;
  private readonly joinStep: number;
  private readonly songEpoch: number;
  private readonly backingGeneration: number;
  private nextRoomSample: number | null = null;

  constructor(config: RoomConfig) {
    if (!Number.isInteger(config.sampleRate) || config.sampleRate < 8_000
      || config.sampleRate > 192_000
      || !Number.isInteger(config.frameMs) || config.frameMs < 5 || config.frameMs > 40
      || !Number.isSafeInteger(config.songEpoch)
      || !Number.isSafeInteger(config.backingGeneration)
      || !Number.isFinite(config.prebufferMs) || config.prebufferMs < 0
      || !Number.isFinite(config.retentionMs) || config.retentionMs <= 0
    ) throw new Error('Invalid canonical Choir experiment configuration');
    this.frameSamples = Math.round(config.sampleRate * config.frameMs / 1000);
    this.sampleRate = config.sampleRate;
    // A second singer joining an already active Mic bus has no MixBus
    // semantic ownership transition. Fade that *individual* contribution
    // over 10ms rather than introducing an instantaneous PCM discontinuity.
    this.joinStep = 1 / Math.max(1, Math.round(config.sampleRate * .010));
    this.songEpoch = config.songEpoch;
    this.backingGeneration = config.backingGeneration;
    this.contentHistoryMs = config.contentHistoryMs ?? null;
    this.backingContentHistory = this.contentHistoryMs === null
      ? null : new ChoirContentPcmBuffer(config.sampleRate, this.contentHistoryMs);
    this.micOptions = {
      sampleRate: config.sampleRate, frameMs: config.frameMs,
      frameSamples: this.frameSamples,
      prebufferMs: config.prebufferMs, retentionMs: config.retentionMs,
      safetyMs: 200, slewFraction: .01,
      sourceEdgeFadeSamples: Math.max(1, Math.round(config.sampleRate * .002)),
      readHeadCrossfadeMs: 5,
    };
    const ceiling = new MicTrack(this.micOptions).limiter.ceiling;
    this.voiceCeiling = ceiling;
    this.bus = new MixBus({
      sampleRate: config.sampleRate,
      backingGain: config.backingGain ?? .65,
      voiceCeiling: ceiling,
    });
    this.bus.setBackingExpected(true, false);
    this.bus.reset();
  }

  private matchesEpoch(id: CanonicalChoirSingerId) {
    return id.songEpoch === this.songEpoch
      && id.backingGeneration === this.backingGeneration;
  }

  addSinger(id: CanonicalChoirSingerId): boolean {
    if (!this.matchesEpoch(id) || !Number.isSafeInteger(id.mediaEpoch)
      || id.mediaEpoch < 0 || !id.participantId
      || this.slots.has(id.participantId) || this.slots.size >= 2) return false;
    const mic = new MicTrack(this.micOptions);
    this.slots.set(id.participantId, {
      identity: { ...id }, mic,
      contentHistory: this.contentHistoryMs === null ? null
        : new ChoirContentPcmBuffer(this.sampleRate, this.contentHistoryMs),
      expected: true, joinGain: 0,
      latePacketDrops: 0, awaitingCalibration: false, authority: null,
      pendingReacquisition: null, requiresFreshContent: false,
    });
    this.bus.setMicExpected(true, true);
    return true;
  }

  /** Used only to preflight explicit server admission; never user-supplied auth. */
  mediaEpochFor(participantId: string): number | null {
    return this.slots.get(participantId)?.identity.mediaEpoch ?? null;
  }

  /**
   * A disconnected capture is replaceable only AFTER every buffered sample
   * that could become audible has passed the immutable output read head and
   * its real missing-source fade has completed. The preceding PCM and capture
   * calibration must never be spliced into the new authenticated media epoch.
   */
  canRebindDisconnected(participantId: string): boolean {
    const slot = this.slots.get(participantId);
    if (!slot || slot.expected || this.nextRoomSample === null) return false;
    const old = slot.mic;
    // A source with NO previously emitted audible trajectory has no
    // acoustic tail to retire, even if PCM arrived or calibration was just
    // accepted before the first output frame. Immutable due frames were
    // already sealed before disconnect by the trusted coordinator.
    if (slot.joinGain === 0 && old.lastEmittedMicSourceSample === null)
      return true;
    return old.edge.silenced
      && old.lastEmittedMicSourceSample !== null
      && old.lastEmittedMicSourceSample >= old.timeline.totalSamples - 1;
  }

  /**
   * A server-authorized reconnect creates one fresh MicTrack in the SAME
   * singer seat after the old tail reached silence. No simultaneous copies,
   * no old calibration/trim/gain/evidence carryover, and no new mixer slot.
   */
  replaceDisconnectedSinger(id: CanonicalChoirSingerId): boolean {
    if (!this.matchesEpoch(id)
      || !Number.isSafeInteger(id.mediaEpoch) || id.mediaEpoch < 0
      || !this.canRebindDisconnected(id.participantId)) return false;
    const old = this.slots.get(id.participantId)!;
    if (id.mediaEpoch <= old.identity.mediaEpoch) return false;
    this.slots.set(id.participantId, {
      identity: { ...id },
      mic: new MicTrack(this.micOptions),
      contentHistory: this.contentHistoryMs === null ? null
        : new ChoirContentPcmBuffer(this.sampleRate, this.contentHistoryMs),
      expected: true,
      joinGain: 0,
      latePacketDrops: 0,
      awaitingCalibration: true,
      authority: null,
      pendingReacquisition: null,
      requiresFreshContent: old.pendingReacquisition !== null,
    });
    this.bus.setMicExpected(true, true);
    return true;
  }

  /**
   * The new capture stays muted until server-side Content/Sample/Boot
   * validation has explicitly accepted THIS media epoch. A Content hold,
   * a raw unconfirmed candidate or an old media epoch cannot unmute it.
   */
  acceptReboundAlignment(id: CanonicalChoirSingerId, decision: ChoirAlignmentDecision): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !slot.expected || !slot.awaitingCalibration
      || slot.requiresFreshContent
      || !this.matchesEpoch(id) || slot.identity.mediaEpoch !== id.mediaEpoch
      // A decision arriving before the first PCM cannot be bound to a native
      // capture generation. Do not record a null authority that can never be
      // revalidated by later Content proof.
      || slot.mic.timeline.generation === null
      || slot.mic.timeline.sourceRate === null
      || !['content', 'sample-song-estimate', 'boot-probe-estimate'].includes(decision.source)
      || decision.advanceMs === null || !Number.isFinite(decision.advanceMs)
      || Math.abs(decision.advanceMs) > 2_800) return false;
    slot.mic.alignmentState.calibratedMicLagMs = decision.advanceMs;
    slot.mic.calibratedMicLagTargetMs = decision.advanceMs;
    slot.mic.edge.beginReplacement();
    slot.awaitingCalibration = false;
    slot.authority = {
      source: decision.source as 'content' | 'sample-song-estimate' | 'boot-probe-estimate',
      firstAdvanceMs: decision.advanceMs,
      revision: 0,
      captureGeneration: slot.mic.timeline.generation,
      sourceRate: slot.mic.timeline.sourceRate,
    };
    return true;
  }

  /**
   * A large disagreement must not move a live Mic by a large PCM jump.
   * Stage an explicit re-acquisition requirement while retaining the current
   * fallback's actual output. Only disconnect + safe tail retirement + a NEW
   * server-owned Media Epoch can satisfy this proposal.
   *
   * The revision and decision are assumed verified by the caller, not raw
   * observations. A proposal itself grants NO playback authority.
   */
  stageLargeContentReacquisition(
    id: CanonicalChoirSingerId, revision: number,
    decision: ChoirAlignmentDecision, takeFrozen: boolean,
  ): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !this.matchesEpoch(id) || slot.identity.mediaEpoch !== id.mediaEpoch
      || !slot.expected || slot.awaitingCalibration || takeFrozen
      || !slot.authority || slot.authority.source === 'content'
      || slot.pendingReacquisition !== null
      || !Number.isSafeInteger(revision) || revision <= slot.authority.revision
      || decision.source !== 'content'
      || decision.advanceMs === null || !Number.isFinite(decision.advanceMs)
      || Math.abs(decision.advanceMs) > 2_800
      || this.nextRoomSample === null) return false;
    const mic = slot.mic;
    if (mic.timeline.generation === null
      || mic.timeline.generation !== slot.authority.captureGeneration
      || mic.timeline.sourceRate !== slot.authority.sourceRate
      || mic.alignmentState.calibratedMicLagMs === null
      || mic.calibratedMicLagTargetMs === null
      || slot.joinGain <= 0
      || mic.lastEmittedMicSourceSample === null
      || !mic.lastEmittedMicFrameComplete) return false;
    // Same 5ms policy as live Content recovery. Never staircase corrections.
    if (Math.abs(decision.advanceMs - mic.calibratedMicLagTargetMs) <= 5
      && Math.abs(decision.advanceMs - slot.authority.firstAdvanceMs) <= 5)
      return false;
    slot.pendingReacquisition = { revision, targetMs: decision.advanceMs };
    // Deliberately do NOT assign calibratedMicLagTargetMs or mute the singer.
    return true;
  }

  /**
   * Fresh acoustic Content after an explicit Media-Epoch replacement.
   * Capture generation must be observed in the NEW MicTrack. A plain
   * acceptReboundAlignment() cannot satisfy requiresFreshContent.
   * This method still relies on upstream independent evidence verification.
   */
  acceptReacquiredContent(
    id: CanonicalChoirSingerId,
    proof: { mediaEpoch: number; captureGeneration: number; revision: number },
    decision: ChoirAlignmentDecision,
  ): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !slot.requiresFreshContent || !slot.awaitingCalibration
      || !slot.expected || !this.matchesEpoch(id)
      || slot.identity.mediaEpoch !== id.mediaEpoch
      || proof.mediaEpoch !== id.mediaEpoch
      || !Number.isSafeInteger(proof.revision) || proof.revision < 1
      || !Number.isSafeInteger(proof.captureGeneration)
      || slot.mic.timeline.generation === null
      || proof.captureGeneration !== slot.mic.timeline.generation
      || decision.source !== 'content'
      || decision.advanceMs === null || !Number.isFinite(decision.advanceMs)
      || Math.abs(decision.advanceMs) > 2_800) return false;
    slot.mic.alignmentState.calibratedMicLagMs = decision.advanceMs;
    slot.mic.calibratedMicLagTargetMs = decision.advanceMs;
    slot.mic.edge.beginReplacement();
    slot.awaitingCalibration = false;
    slot.requiresFreshContent = false;
    slot.authority = {
      source: 'content', firstAdvanceMs: decision.advanceMs, revision: proof.revision,
      captureGeneration: proof.captureGeneration,
      sourceRate: slot.mic.timeline.sourceRate,
    };
    return true;
  }

  /**
   * Experimental live recovery from an authorized fallback to fresh Content.
   * The trusted coordinator supplies a monotonic proof revision; neither a raw
   * client candidate nor a diagnostic residual is sufficient.
   *
   * Only a small correction within the INITIAL capture authority is allowed.
   * This prevents many individually-small decisions staircasing a singer
   * into a large, inaudible jump. Larger disagreements need a fresh, explicit
   * capture reacquisition protocol, not a live read-head replacement.
   */
  recoverContentWithoutJump(
    id: CanonicalChoirSingerId, revision: number,
    decision: ChoirAlignmentDecision, takeFrozen: boolean,
  ): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !this.matchesEpoch(id) || slot.identity.mediaEpoch !== id.mediaEpoch
      || !slot.expected || slot.awaitingCalibration || takeFrozen
      || !slot.authority
      || slot.authority.source === 'content'
      || slot.pendingReacquisition !== null
      || decision.source !== 'content'
      || decision.advanceMs === null || !Number.isFinite(decision.advanceMs)
      || Math.abs(decision.advanceMs) > 2_800
      || !Number.isSafeInteger(revision) || revision <= slot.authority.revision
      || this.nextRoomSample === null) return false;
    const mic = slot.mic;
    const current = mic.alignmentState.calibratedMicLagMs;
    const currentTarget = mic.calibratedMicLagTargetMs;
    // Do not swap a target while an earlier correction or capture transition
    // is in progress. An old source generation cannot authorize a new one.
    if (current === null || currentTarget === null
      || Math.abs(currentTarget - current) > 0.001
      || !mic.lastEmittedMicFrameComplete
      || mic.lastEmittedMicAdvanceSamples === null
      || mic.timeline.generation === null
      || mic.timeline.generation !== slot.authority.captureGeneration
      || mic.timeline.sourceRate !== slot.authority.sourceRate) return false;
    const delta = decision.advanceMs - currentTarget;
    const MAX_LIVE_CORRECTION_MS = 5; // Unvalidated experimental guard, not a device-specific tolerance.
    if (Math.abs(delta) > MAX_LIVE_CORRECTION_MS
      || Math.abs(decision.advanceMs - slot.authority.firstAdvanceMs) > MAX_LIVE_CORRECTION_MS)
      return false;
    const nextRequest = mic.requestedMicAdvanceMs + delta;
    if (Math.abs(mic.budgetedMicAdvanceMs(nextRequest) - nextRequest) > 0.001)
      return false;
    // Both trajectories, including the canonical limiter's look-ahead, need
    // actual retained capture PCM before a live transition may be authorized.
    const oldStart = Math.floor(this.nextRoomSample + mic.lastEmittedMicAdvanceSamples);
    const newStart = Math.floor(oldStart + delta * this.sampleRate / 1_000);
    const count = this.frameSamples + mic.limiter.lookaheadSamples + 2;
    for (const start of [oldStart, newStart]) {
      const evidence = readPcmEvidence(mic.timeline, start, count);
      if (evidence.gapSamples !== 0 || evidence.frontierMissingSamples !== 0)
        return false;
    }
    // MicTrack.planMicRead owns the existing 1%-per-frame fractional read
    // slew, limiter, frontier and output edge. Do not copy or jump that code.
    mic.calibratedMicLagTargetMs = decision.advanceMs;
    slot.authority.source = 'content';
    slot.authority.revision = revision;
    return true;
  }

  /**
   * Read ONLY separately buffered, source-authentic PCM for Content matching.
   * Playback retention can remain three seconds while this bounded cache
   * holds the six-second acoustic evidence. No silent padding, concealment,
   * stale capture or Robot generation can qualify.
   */
  readTrustedContentWindow(
    id: CanonicalChoirSingerId, captureGeneration: number,
    startSample: number,
  ): { mic: Int16Array; backing: Int16Array } | null {
    const slot = this.slots.get(id.participantId);
    const count = 6 * this.sampleRate;
    if (!slot || !slot.expected || !this.matchesEpoch(id)
      || id.mediaEpoch !== slot.identity.mediaEpoch
      || !slot.contentHistory || !this.backingContentHistory
      || !Number.isSafeInteger(captureGeneration) || captureGeneration < 0
      || slot.mic.timeline.generation !== captureGeneration
      || slot.mic.timeline.sourceRate === null
      || this.backing.generation !== this.backingGeneration
      || this.backing.sourceRate === null
      || !slot.contentHistory.hasFullPositionedWindow(
        captureGeneration, slot.mic.timeline.sourceRate, startSample, count)
      || !this.backingContentHistory.hasFullPositionedWindow(
        this.backingGeneration, this.backing.sourceRate, startSample, count))
      return null;
    return {
      mic: slot.contentHistory.read(startSample, count),
      backing: this.backingContentHistory.read(startSample, count),
    };
  }

  /**
   * Discards Content evidence when trusted Robot playback becomes invalid.
   * This does NOT touch Mic PCM, MixBus or the immutable output room clock.
   */
  invalidateContentEvidenceHistory() {
    this.backingContentHistory?.reset();
    for (const slot of this.slots.values()) slot.contentHistory?.reset();
  }

  contentHistorySamples(participantId: string) {
    return {
      mic: this.slots.get(participantId)?.contentHistory?.sampleCount ?? 0,
      backing: this.backingContentHistory?.sampleCount ?? 0,
    };
  }

  /** Read-only trusted capture state for the experimental Content proof gate. */
  contentProofState(id: CanonicalChoirSingerId) {
    const slot = this.slots.get(id.participantId);
    if (!slot || !slot.expected || !this.matchesEpoch(id)
      || slot.identity.mediaEpoch !== id.mediaEpoch) return null;
    return {
      captureGeneration: slot.mic.timeline.generation,
      sourceRate: slot.mic.timeline.sourceRate,
      awaitingCalibration: slot.awaitingCalibration,
      requiresFreshContent: slot.requiresFreshContent,
      reacquisitionPending: slot.pendingReacquisition !== null,
      authoritySource: slot.authority?.source ?? null,
      authorityAdvanceMs: slot.mic.calibratedMicLagTargetMs,
    };
  }

  /** End a publisher without promoting/reassigning the other singer. */
  disconnect(id: CanonicalChoirSingerId): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !this.matchesEpoch(id) || slot.identity.mediaEpoch !== id.mediaEpoch)
      return false;
    slot.expected = false;
    this.bus.setMicExpected([...this.slots.values()].some(s => s.expected), true);
    // Retained PCM / source edges continue to render until read through.
    return true;
  }

  ingestMic(id: CanonicalChoirSingerId, frame: PcmFrame,
    sourceRate: number, roomNowSample: number): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !slot.expected || !this.matchesEpoch(id)
      || slot.identity.mediaEpoch !== id.mediaEpoch
      || !Number.isSafeInteger(roomNowSample) || roomNowSample < 0
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000)
      return false;
    // This test room only supports authenticated, positioned capture frames.
    // The production N=1 legacy/unheadered compatibility path is untouched.
    if (!Buffer.isBuffer(frame.pcm)) return false;
    const packetSamples = frame.pcm.byteLength / 2;
    if (frame.pcm.byteLength % 2 !== 0
      || !Number.isSafeInteger(packetSamples) || packetSamples < 1
      || packetSamples > 2 * sourceRate
      || !Number.isSafeInteger(frame.generation) || frame.generation! < 0
      || !Number.isSafeInteger(frame.firstSampleIndex)
      || frame.firstSampleIndex! < 0
      || !Number.isSafeInteger(frame.firstSampleIndex! + packetSamples)) return false;
    const source = slot.mic.timeline;
    if (source.generation !== null
      && frame.generation === source.generation
      && source.sourceRate === sourceRate
      && slot.mic.lastEmittedMicSourceSample !== null) {
      // Even a packet not yet in the ingest frontier must not fill already
      // emitted room samples. The playback deadline is an immutable read edge.
      const endExclusive = slot.mic.sourceSampleToSessionSample(
        frame.firstSampleIndex! + packetSamples, sourceRate,
      );
      if (endExclusive <= Math.floor(slot.mic.lastEmittedMicSourceSample) + 1) {
        slot.latePacketDrops++;
        return false;
      }
    }
    if (source.generation !== null) {
      if (frame.generation! < source.generation) return false;
      if (frame.generation === source.generation && source.sourceRate === sourceRate) {
        // A distant future timestamp can move the ring's retention beyond
        // audio not yet emitted. Compare in trusted room coordinates, NOT to
        // a capture-clock index that may start at millions after reconnect.
        const mappedStart = slot.mic.sourceSampleToSessionSample(
          frame.firstSampleIndex!, sourceRate,
        );
        const maximumFutureStart = roomNowSample + 2 * this.sampleRate;
        if (mappedStart > maximumFutureStart) return false;
        if (source.sourceFrontier !== null
          && frame.firstSampleIndex! + packetSamples <= source.sourceFrontier)
          return false;
      }
    }
    const priorChunks = slot.mic.timeline.chunks.length;
    slot.mic.ingestCapture({
      frame, sourceRate, running: true,
      roomSampleNow: () => roomNowSample,
    });
    slot.contentHistory?.captureAccepted(slot.mic.timeline, priorChunks);
    return true;
  }

  ingestBacking(frame: PcmFrame, sourceRate: number,
    roomNowSample: number): boolean {
    if (!Number.isSafeInteger(roomNowSample) || roomNowSample < 0
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000)
      return false;
    const previousGeneration = this.backing.generation;
    const priorChunks = this.backing.chunks.length;
    const result = ingestPcmTimeline({
      timeline: this.backing, frame, sourceRate, mixRate: this.sampleRate,
      roomSampleNow: () => roomNowSample, trackSourceClock: true,
    });
    // Retained chunks can outlive a Robot capture-generation restart.
    // Content evidence must never combine old chunks with a new source label.
    if (previousGeneration !== this.backing.generation
      && result.samples.length > 0)
      this.backingCaptureOriginSample = result.start;
    this.backingContentHistory?.captureAccepted(this.backing, priorChunks);
    return true;
  }

  /** Server-confirmed alignment only; does NOT accept unvalidated candidates. */
  setConfirmedLag(id: CanonicalChoirSingerId, lagMs: number): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !slot.expected || !this.matchesEpoch(id)
      || slot.identity.mediaEpoch !== id.mediaEpoch
      || !Number.isFinite(lagMs) || Math.abs(lagMs) > 2_800) return false;
    if (this.nextRoomSample !== null) return false;
    // Never hard-jump a *live* read head inside this harness. The production
    // coordinator must own per-singer Content validation and smooth changes.
    slot.mic.alignmentState.calibratedMicLagMs = lagMs;
    slot.mic.calibratedMicLagTargetMs = lagMs;
    return true;
  }

  setGainDb(id: CanonicalChoirSingerId, db: number): boolean {
    const slot = this.slots.get(id.participantId);
    if (!slot || !this.matchesEpoch(id)
      || slot.identity.mediaEpoch !== id.mediaEpoch
      || !Number.isFinite(db)) return false;
    slot.mic.gain.setTargetDb(db, false);
    return true;
  }

  render(roomStartSample: number): CanonicalChoirFrame {
    if (!Number.isSafeInteger(roomStartSample) || roomStartSample < 0
      || (this.nextRoomSample !== null && roomStartSample !== this.nextRoomSample))
      throw new Error('Room output must be monotonic and contiguous');
    const sorted = [...this.slots.values()].sort((a, b) =>
      a.identity.participantId.localeCompare(b.identity.participantId)
    );
    const tracks = sorted.map(slot => {
      const plan = slot.mic.planMicRead(roomStartSample,
        slot.expected && !slot.awaitingCalibration);
      slot.mic.measureReadHeadroom(plan, slot.expected);
      const read = slot.mic.readMicFrame(plan);
      const evidence: CanonicalChoirSingerEvidence = {
        participantId: slot.identity.participantId,
        mediaEpoch: slot.identity.mediaEpoch,
        readStartSample: plan.micReadStart,
        voicePeakAbs: 0,
        gapSamples: read.evidence.gapSamples,
        frontierMissingSamples: read.evidence.frontierMissingSamples,
        unheaderedSamples: read.evidence.unheaderedSamples
          + read.crossfadeUnheaderedSamplesDelta,
        inputClippedSamples: 0,
        limitedSamples: 0,
        heavyLimitedSamples: 0,
        limiterOvershootSamples: 0,
        latePacketDrops: slot.latePacketDrops,
        expected: slot.expected,
        awaitingCalibration: slot.awaitingCalibration,
        calibrationSource: slot.authority?.source ?? null,
        calibrationAppliedMs: slot.mic.alignmentState.calibratedMicLagMs,
        calibrationTargetMs: slot.mic.calibratedMicLagTargetMs,
        reacquisitionPending: slot.pendingReacquisition !== null,
        requiresFreshContent: slot.requiresFreshContent,
      };
      if (!slot.awaitingCalibration) {
        slot.mic.lastEmittedMicFrameComplete =
          read.evidence.gapSamples === 0 && read.evidence.frontierMissingSamples === 0;
        slot.mic.lastEmittedMicAdvanceSamples = plan.advanceSamplesExact;
      }
      return { slot, plan, read, evidence };
    });
    const backing = readPcmRange(this.backing, roomStartSample, this.frameSamples);
    const backingEvidence = readPcmEvidence(
      this.backing, roomStartSample, this.frameSamples,
    );
    const backingMask = backingEvidence.gapSamples > 0
      ? readPcmGapMask(this.backing, roomStartSample, this.frameSamples) : null;
    const voiceWeight = 1 / 2; // two FULL-volume singer ceilings share one Mic bus
    const pcm = new Int16Array(this.frameSamples);
    const duckTarget = this.bus.duckTarget();
    let outputClippedSamples = 0;
    for (let i = 0; i < this.frameSamples; i++) {
      this.bus.advanceDuck(duckTarget);
      let voices = 0;
      let anyAudibleSource = false;
      for (const { slot, plan, read, evidence } of tracks) {
        if (slot.awaitingCalibration) {
          // Keep the source's output edge at silence. Never commit an
          // audible read-head/limiter history before new verified alignment.
          slot.mic.edge.apply(0, false, true);
          continue;
        }
        const sourceSample = read.slew
          ? read.slew.firstPosition + i * read.slew.rate
          : plan.micReadStart + i;
        const missingEvidence = read.slew
          ? read.slew.missingMask[i] === 1
          : read.gapMask?.[i] === 1 || i >= read.frontierMissingStart;
        const missingAudible = sourceSample < 0 || missingEvidence;
        const result = slot.mic.processVoiceSample({
          samples: read.samples, i, sourceSample,
          micReadStart: plan.micReadStart, slew: read.slew,
          slewFrameEndPosition: read.slew
            ? read.slew.firstPosition + this.frameSamples * read.slew.rate : 0,
          evidenceMissing: missingEvidence, audibleMissing: missingAudible,
        });
        if (!missingAudible) anyAudibleSource = true;
        evidence.voicePeakAbs = Math.max(evidence.voicePeakAbs, Math.abs(result.voice));
        // The peak limiter has finite attack even with 3ms lookahead. Its
        // transient output can overshoot the nominal ceiling during the first
        // ~2ms of a hot capture. The N=2 bus must NOT reserve headroom based
        // on a ceiling that has not actually been enforced. Record the excess
        // explicitly before bounding each singer's bus contribution.
        const boundedVoice = Math.max(
          -this.voiceCeiling, Math.min(this.voiceCeiling, result.voice),
        );
        if (boundedVoice !== result.voice) evidence.limiterOvershootSamples++;
        if (!missingAudible && slot.expected) {
          slot.joinGain = Math.min(1, slot.joinGain + this.joinStep);
        }
        voices += boundedVoice * voiceWeight * slot.joinGain;
        if (result.limited) evidence.limitedSamples++;
        if (result.heavilyLimited) evidence.heavyLimitedSamples++;
        const clipped = read.inputClippingMask?.[i] === 1;
        if (clipped && !missingEvidence) evidence.inputClippedSamples++;
      }
      const backingMissing = backingMask?.[i] === 1
        || roomStartSample + i >= this.backing.totalSamples;
      const value = this.bus.mixSample(
        voices, backing[i] / 32768 * this.bus.songGain,
        this.bus.twoSourceOwnership, !anyAudibleSource, backingMissing,
      );
      if (value > 1 || value < -1) outputClippedSamples++;
      const clamped = Math.max(-1, Math.min(1, value));
      pcm[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
    }
    this.nextRoomSample = roomStartSample + this.frameSamples;
    if (!sorted.some(s => s.expected)
      && sorted.every(s => s.mic.edge.silenced)) {
      this.bus.releaseMicHold();
    }
    return {
      roomStartSample, pcm,
      singers: tracks.map(s => s.evidence),
      backingGapSamples: backingEvidence.gapSamples,
      outputClippedSamples,
    };
  }
}
