import { MixBus } from './mix-bus.js';
import { MicTrack } from './mic-track.js';
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
  expected: boolean;
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
  expected: boolean;
  /** Separate entrance fade; room MixBus cannot detect an additional Mic. */
  joinGain: number;
};

type RoomConfig = {
  sampleRate: number;
  frameMs: number;
  prebufferMs: number;
  retentionMs: number;
  songEpoch: number;
  backingGeneration: number;
  backingGain?: number;
};

export class CanonicalChoirMixExperiment {
  private readonly slots = new Map<string, Slot>();
  private readonly backing = emptyPcmTimeline();
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
      identity: { ...id }, mic, expected: true, joinGain: 0,
    });
    this.bus.setMicExpected(true, true);
    return true;
  }

  /** Used only to preflight explicit server admission; never user-supplied auth. */
  mediaEpochFor(participantId: string): number | null {
    return this.slots.get(participantId)?.identity.mediaEpoch ?? null;
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
    const packetSamples = frame.pcm.byteLength / 2;
    if (!Buffer.isBuffer(frame.pcm) || frame.pcm.byteLength % 2 !== 0
      || !Number.isSafeInteger(packetSamples) || packetSamples < 1
      || packetSamples > 2 * sourceRate
      || !Number.isSafeInteger(frame.generation) || frame.generation! < 0
      || !Number.isSafeInteger(frame.firstSampleIndex)
      || frame.firstSampleIndex! < 0
      || !Number.isSafeInteger(frame.firstSampleIndex! + packetSamples)) return false;
    const source = slot.mic.timeline;
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
    slot.mic.ingestCapture({
      frame, sourceRate, running: true,
      roomSampleNow: () => roomNowSample,
    });
    return true;
  }

  ingestBacking(frame: PcmFrame, sourceRate: number,
    roomNowSample: number): boolean {
    if (!Number.isSafeInteger(roomNowSample) || roomNowSample < 0
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000)
      return false;
    ingestPcmTimeline({
      timeline: this.backing, frame, sourceRate, mixRate: this.sampleRate,
      roomSampleNow: () => roomNowSample, trackSourceClock: true,
    });
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
      const plan = slot.mic.planMicRead(roomStartSample, slot.expected);
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
        expected: slot.expected,
      };
      slot.mic.lastEmittedMicFrameComplete =
        read.evidence.gapSamples === 0 && read.evidence.frontierMissingSamples === 0;
      slot.mic.lastEmittedMicAdvanceSamples = plan.advanceSamplesExact;
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
