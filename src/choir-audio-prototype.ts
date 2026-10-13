import { MixBus } from './mix-bus.js';
import {
  planChoirRead, type ChoirTrackAnchor, type ChoirReadRequest,
} from './choir-read-plan.js';
import type { ChoirCalibrationSource } from './choir-calibration-experiment.js';

/**
 * Independent, executable dual-singer audio experiment. Not imported by the
 * production server. It uses the existing MixBus for the final voice+backing
 * sum, but does NOT replace AudioSession or its capture reconstruction.
 *
 * Input sample indices belong to each singer's own capture clock. Anchors
 * supplied by a *separate, validated* calibration coordinator turn shared
 * room-sample positions into individual native Mic sample positions.
 */
export type ChoirAudioIdentity = {
  participantId: string;
  songEpoch: number;
  captureGeneration: number;
  backingGeneration: number;
  micSampleRate: number;
};

export type ChoirMicPacket = {
  participantId: string;
  songEpoch: number;
  backingGeneration: number;
  captureGeneration: number;
  firstSampleIndex: number;
  pcm: Int16Array;
};

export type ChoirAudioOptions = {
  sampleRate: number;
  frameSamples: number;
  outputHoldbackMs: number;
  retentionMs: number;
  maxSingers?: number;
  backingGain?: number;
  fadeMs?: number;
};

export type SingerFrameEvidence = {
  participantId: string;
  calibration: ChoirCalibrationSource | 'none';
  availableSamples: number;
  missingSamples: number;
  latePackets: number;
};

export type ChoirAudioFrame =
  | { state: 'waiting'; requiredRoomSample: number }
  | {
      state: 'ready';
      roomStartSample: number;
      pcm: Int16Array;
      singers: SingerFrameEvidence[];
      outputClippedSamples: number;
    };

type Track = {
  identity: ChoirAudioIdentity;
  value: Int16Array;
  stamps: Float64Array;
  latestWrittenExclusive: number;
  consumedExclusive: number;
  latePackets: number;
  anchor: ChoirTrackAnchor | null;
  calibration: ChoirCalibrationSource | 'none';
  pending: { anchor: ChoirTrackAnchor; source: ChoirCalibrationSource } | null;
  fade: number;
  lastVoice: number;
};

function positiveSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function nonnegativeSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function sameIdentity(a: ChoirAudioIdentity, b: ChoirAudioIdentity): boolean {
  return a.participantId === b.participantId
    && a.songEpoch === b.songEpoch
    && a.captureGeneration === b.captureGeneration
    && a.backingGeneration === b.backingGeneration
    && a.micSampleRate === b.micSampleRate;
}

/** A fixed bounded ring; sample stamps prevent stale wraparound playback. */
function bufferedSample(track: Track, index: number): number | null {
  if (!nonnegativeSafe(index) || index < track.latestWrittenExclusive - track.value.length) return null;
  const slot = index % track.value.length;
  return track.stamps[slot] === index ? track.value[slot] / 32768 : null;
}

function readInterpolated(track: Track, position: number): number | null {
  if (!Number.isFinite(position) || position < 0) return null;
  const index = Math.floor(position);
  const first = bufferedSample(track, index);
  if (first === null) return null;
  const fraction = position - index;
  if (fraction === 0) return first;
  const second = bufferedSample(track, index + 1);
  return second === null ? null : first + (second - first) * fraction;
}

export class ChoirAudioPrototype {
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly delaySamples: number;
  private readonly retentionMs: number;
  private readonly maxSingers: number;
  private readonly fadeStep: number;
  private readonly bus: MixBus;
  private readonly tracks = new Map<string, Track>();
  private nextOutputSample: number | null = null;
  private roomEpoch: { songEpoch: number; backingGeneration: number } | null = null;

  constructor(options: ChoirAudioOptions) {
    if (!positiveSafe(options.sampleRate) || !positiveSafe(options.frameSamples)
      || !Number.isFinite(options.outputHoldbackMs) || options.outputHoldbackMs < 0
      || !Number.isFinite(options.retentionMs) || options.retentionMs < options.outputHoldbackMs + 50) {
      throw new RangeError('Invalid Choir sample rate, frame length, holdback or retention.');
    }
    this.sampleRate = options.sampleRate;
    this.frameSamples = options.frameSamples;
    this.delaySamples = Math.ceil(options.outputHoldbackMs * this.sampleRate / 1000);
    this.retentionMs = options.retentionMs;
    this.maxSingers = options.maxSingers ?? 2;
    if (!positiveSafe(this.maxSingers) || this.maxSingers > 2) {
      throw new RangeError('The prototype has verified headroom for at most two singers.');
    }
    const fadeMs = options.fadeMs ?? 10;
    if (!Number.isFinite(fadeMs) || fadeMs <= 0 || fadeMs > 100) {
      throw new RangeError('Invalid Choir fade.');
    }
    this.fadeStep = 1 / Math.max(1, Math.round(fadeMs * this.sampleRate / 1000));
    // Each singer contributes <= 0.45. Two voices are <= 0.9, the ceiling
    // supplied to the existing MixBus. Preserve stable gain as people drop.
    this.bus = new MixBus({
      sampleRate: this.sampleRate,
      backingGain: options.backingGain ?? 0.65,
      voiceCeiling: 0.45 * this.maxSingers,
    });
    this.bus.setBackingExpected(true, false);
    this.bus.reset();
  }

  addSinger(identity: ChoirAudioIdentity): boolean {
    if (!identity.participantId || identity.participantId.trim() !== identity.participantId
      || !nonnegativeSafe(identity.songEpoch)
      || !nonnegativeSafe(identity.captureGeneration)
      || !nonnegativeSafe(identity.backingGeneration)
      || !positiveSafe(identity.micSampleRate)
      || identity.micSampleRate < 8_000 || identity.micSampleRate > 192_000) return false;
    const current = this.tracks.get(identity.participantId);
    if (this.roomEpoch && (
      identity.songEpoch !== this.roomEpoch.songEpoch
      || identity.backingGeneration !== this.roomEpoch.backingGeneration
    )) return false;
    if (!current && this.tracks.size >= this.maxSingers) return false;
    if (current && sameIdentity(current.identity, identity)) return false;
    const capacity = Math.ceil(this.retentionMs * identity.micSampleRate / 1000) + 2;
    if (!Number.isSafeInteger(capacity) || capacity > 1_000_000) return false;
    const stamps = new Float64Array(capacity);
    stamps.fill(-1);
    this.tracks.set(identity.participantId, {
      identity: { ...identity }, value: new Int16Array(capacity), stamps,
      latestWrittenExclusive: 0, consumedExclusive: 0, latePackets: 0,
      anchor: null, calibration: 'none', pending: null, fade: 0, lastVoice: 0,
    });
    if (this.roomEpoch === null) {
      this.roomEpoch = { songEpoch: identity.songEpoch, backingGeneration: identity.backingGeneration };
    }
    this.syncMicIntent();
    return true;
  }

  /** Explicit leave or expired transport grace. Never promotes another singer. */
  removeSinger(participantId: string): boolean {
    const removed = this.tracks.delete(participantId);
    if (removed) this.syncMicIntent();
    return removed;
  }

  /**
   * The anchor must already have been derived from authenticated, singer-
   * specific timing evidence. A raw correlation candidate is not enough.
   * Replacing an anchor fades this track back in; peers are left untouched.
   */
  installAnchor(anchor: ChoirTrackAnchor, source: ChoirCalibrationSource): boolean {
    const track = this.tracks.get(anchor.participantId);
    if (!track || source === 'unavailable'
      || source === 'content-held'
      || anchor.songEpoch !== track.identity.songEpoch
      || anchor.captureGeneration !== track.identity.captureGeneration
      || anchor.backingGeneration !== track.identity.backingGeneration
      || anchor.micSampleRate !== track.identity.micSampleRate
      || anchor.roomSampleRate !== this.sampleRate
      || !planChoirRead(anchor, {
        participantId: anchor.participantId,
        songEpoch: anchor.songEpoch, captureGeneration: anchor.captureGeneration,
        backingGeneration: anchor.backingGeneration,
        roomStartSample: anchor.roomSampleAtAnchor, frameSamples: this.frameSamples,
      })) return false;
    if (track.anchor) {
      const referenceRoomSample = this.nextOutputSample ?? Math.max(
        track.anchor.roomSampleAtAnchor, anchor.roomSampleAtAnchor,
      );
      const request = {
        participantId: anchor.participantId,
        songEpoch: anchor.songEpoch,
        captureGeneration: anchor.captureGeneration,
        backingGeneration: anchor.backingGeneration,
        roomStartSample: referenceRoomSample,
        frameSamples: this.frameSamples,
      };
      const prior = planChoirRead(track.anchor, request);
      const next = planChoirRead(anchor, request);
      if (!prior || !next) return false;
      const shiftMs = (next.micFirstSample - prior.micFirstSample) * 1000 / anchor.micSampleRate;
      // A large fallback disagreement is not permission to jump a live read
      // head by hundreds of milliseconds. Require explicit revoke/reacquire
      // instead; this experiment cannot authorize acoustic route changes.
      if (!Number.isFinite(shiftMs) || Math.abs(shiftMs) > 5) return false;
      if (Math.abs(shiftMs) < 1e-7) {
        // A repeated confirmed result must not restart a singer's fade.
        track.calibration = source;
        track.pending = null;
        return true;
      }
      // Even a 1-5 ms phase jump is audible if installed immediately.
      // Fade out the *old* timeline first and adopt the new anchor only
      // at a frame boundary, then fade back in next frame.
      track.pending = { anchor: { ...anchor }, source };
      return true;
    }
    track.anchor = { ...anchor };
    track.calibration = source;
    track.pending = null;
    track.fade = 0;
    track.lastVoice = 0;
    this.syncMicIntent();
    return true;
  }

  /** A held measurement must not move an already playing source read head. */
  holdAnchor(participantId: string): boolean {
    const track = this.tracks.get(participantId);
    return Boolean(track?.anchor);
  }

  revokeAnchor(participantId: string): boolean {
    const track = this.tracks.get(participantId);
    if (!track?.anchor) return false;
    track.anchor = null;
    track.pending = null;
    track.calibration = 'none';
    // Keep the prior audible sample and fade it out on the next emitted
    // frame, rather than cutting it to digital zero at this instant.
    this.syncMicIntent();
    return true;
  }

  private syncMicIntent() {
    this.bus.setMicExpected([...this.tracks.values()].some(track => track.anchor !== null), true);
    if (!this.bus.micExpected
      && ![...this.tracks.values()].some(track => track.fade > 0)) {
      this.bus.releaseMicHold();
    }
  }

  /** Returns 'late' for irrevocably emitted material. No frame is rewritten. */
  receiveMic(packet: ChoirMicPacket): 'accepted' | 'late' | 'invalid' {
    const track = this.tracks.get(packet.participantId);
    if (!track || packet.captureGeneration !== track.identity.captureGeneration
      || packet.songEpoch !== track.identity.songEpoch
      || packet.backingGeneration !== track.identity.backingGeneration
      || !nonnegativeSafe(packet.firstSampleIndex)
      || !(packet.pcm instanceof Int16Array) || packet.pcm.length === 0
      || packet.pcm.length > track.identity.micSampleRate * 2
      || !Number.isSafeInteger(packet.firstSampleIndex + packet.pcm.length)) return 'invalid';

    const end = packet.firstSampleIndex + packet.pcm.length;
    if (track.anchor) {
      const nextRoomPosition = this.nextOutputSample ?? track.anchor.roomSampleAtAnchor;
      const plan = planChoirRead(track.anchor, {
        participantId: track.identity.participantId,
        songEpoch: track.identity.songEpoch,
        captureGeneration: track.identity.captureGeneration,
        backingGeneration: track.identity.backingGeneration,
        roomStartSample: nextRoomPosition,
        frameSamples: this.frameSamples,
      });
      if (!plan) return 'invalid';
      // Future packets must not move the entire ring frontier past audio
      // still due to be mixed. Absolute capture indices may be large, so
      // compare against that capture's trusted anchor, never sample index 0.
      const maximumFutureEnd = Math.ceil(
        plan.micFirstSample + track.value.length + this.frameSamples * plan.micStep,
      );
      if (end > maximumFutureEnd) return 'invalid';
    }
    const oldestRetained = Math.max(0, track.latestWrittenExclusive - track.value.length);
    if (end <= track.consumedExclusive || end <= oldestRetained) {
      track.latePackets++;
      return 'late';
    }
    // Never iterate or write older-than-retention samples in a long packet.
    // A ring slot already stamped with a newer source sample is immutable
    // against a late, reordered packet.
    const start = Math.max(
      packet.firstSampleIndex, track.consumedExclusive,
      oldestRetained, end - track.value.length,
    );
    for (let index = start; index < end; index++) {
      const slot = index % track.value.length;
      // First authenticated arrival owns any overlapping sample.
      if (track.stamps[slot] < index) {
        track.value[slot] = packet.pcm[index - packet.firstSampleIndex];
        track.stamps[slot] = index;
      }
    }
    track.latestWrittenExclusive = Math.max(track.latestWrittenExclusive, end);
    return 'accepted';
  }

  /**
   * One shared deadline and one strictly monotonic room read head. All frames
   * wait for the same fixed delay; missing tracks never extend that delay.
   */
  render(input: {
    roomStartSample: number;
    nowRoomSample: number;
    songEpoch: number;
    backingGeneration: number;
    backing: Int16Array;
  }): ChoirAudioFrame {
    if (!nonnegativeSafe(input.roomStartSample) || !nonnegativeSafe(input.nowRoomSample)
      || !nonnegativeSafe(input.songEpoch) || !nonnegativeSafe(input.backingGeneration)
      || !(input.backing instanceof Int16Array)
      || input.backing.length !== this.frameSamples) {
      throw new RangeError('Invalid Choir render input.');
    }
    if (this.roomEpoch && (
      input.songEpoch !== this.roomEpoch.songEpoch
      || input.backingGeneration !== this.roomEpoch.backingGeneration
    )) {
      throw new Error('Choir room epoch must be reinitialized after a song or backing restart.');
    }
    if (this.nextOutputSample !== null && input.roomStartSample !== this.nextOutputSample) {
      throw new Error('Choir output position must advance by exactly one frame.');
    }
    const deadline = input.roomStartSample + this.frameSamples + this.delaySamples;
    if (input.nowRoomSample < deadline) {
      return { state: 'waiting', requiredRoomSample: deadline };
    }

    const voices = new Float64Array(this.frameSamples);
    const evidence: SingerFrameEvidence[] = [];
    const micRealAt = new Uint8Array(this.frameSamples);

    for (const track of this.tracks.values()) {
      const request: ChoirReadRequest = {
        participantId: track.identity.participantId,
        songEpoch: input.songEpoch,
        captureGeneration: track.identity.captureGeneration,
        backingGeneration: input.backingGeneration,
        roomStartSample: input.roomStartSample,
        frameSamples: this.frameSamples,
      };
      const plan = track.anchor ? planChoirRead(track.anchor, request) : null;
      // Frame diagnostics must describe the samples actually rendered from
      // the OLD anchor, not the pending new one adopted at the frame boundary.
      const frameCalibration = plan ? track.calibration : 'none';
      let availableSamples = 0;
      for (let i = 0; i < this.frameSamples; i++) {
        const sourcePosition = plan ? plan.micFirstSample + i * plan.micStep : -1;
        const sample = plan ? readInterpolated(track, sourcePosition) : null;
        if (sample !== null) {
          availableSamples++;
          micRealAt[i] = 1;
          track.fade = track.pending
            ? Math.max(0, track.fade - this.fadeStep)
            : Math.min(1, track.fade + this.fadeStep);
          track.lastVoice = sample;
          voices[i] += sample * track.fade * 0.45;
        } else {
          // A dropout trails off the last *real* sample for at most fadeMs.
          track.fade = Math.max(0, track.fade - this.fadeStep);
          voices[i] += track.lastVoice * track.fade * 0.45;
        }
      }
      if (track.pending && track.fade === 0) {
        track.anchor = track.pending.anchor;
        track.calibration = track.pending.source;
        track.pending = null;
        track.lastVoice = 0;
      }
      if (plan) {
        // Only the rendered sample trajectory becomes irrevocable.
        track.consumedExclusive = Math.max(
          track.consumedExclusive,
          Math.floor(plan.micFirstSample + this.frameSamples * plan.micStep),
        );
      }
      evidence.push({
        participantId: track.identity.participantId,
        calibration: frameCalibration,
        availableSamples, missingSamples: this.frameSamples - availableSamples,
        latePackets: track.latePackets,
      });
    }

    const pcm = new Int16Array(this.frameSamples);
    let outputClippedSamples = 0;
    for (let i = 0; i < this.frameSamples; i++) {
      this.bus.advanceDuck(this.bus.duckTarget());
      const songContribution = (input.backing[i] / 32768) * this.bus.songGain;
      const value = this.bus.mixSample(
        voices[i], songContribution, this.bus.twoSourceOwnership,
        micRealAt[i] === 0, false,
      );
      if (Math.abs(value) > 1) outputClippedSamples++;
      pcm[i] = Math.round(Math.max(-1, Math.min(32767 / 32768, value)) * 32768);
    }
    this.nextOutputSample = input.roomStartSample + this.frameSamples;
    // The departing last voice has now finished its audible tail. The existing
    // MixBus can relinquish its held two-source headroom safely.
    if (!this.bus.micExpected
      && ![...this.tracks.values()].some(track => track.fade > 0)) {
      this.bus.releaseMicHold();
    }
    return {
      state: 'ready', roomStartSample: input.roomStartSample,
      pcm, singers: evidence, outputClippedSamples,
    };
  }
}
