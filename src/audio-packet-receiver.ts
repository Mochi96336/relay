import {
  decodeAudioPacket,
  type AudioPacket,
  type AudioPacketSource,
} from './audio-packet.js';

const HALF_SEQUENCE_SPACE = 0x8000_0000;
const CONTINUITY_TTL_MS = 15_000;
const MAX_CONTINUITY_SNAPSHOTS = 8;
const RESYNC_FORWARD_WINDOW_MULTIPLIER = 32;

export type AudioPacketReceiverOptions = {
  source: AudioPacketSource;
  generation: number;
  /**
   * First sequence authorized for this receiver. When omitted, the first valid
   * packet establishes the sequence origin; this is required after a Relay
   * process restart because the continuing phone capture does not reset its
   * sequence counter.
   */
  initialSequence?: number;
  reorderWindowPackets: number;
  reorderDeadlineMs: number;
  maxForwardJumpPackets: number;
  /**
   * Longest a missing packet may hold the ordered stream, waiting for its
   * late arrival or its requested repeat, while the caller says the mix can
   * afford it. 0 disables holding and retransmission requests entirely.
   */
  retransmitHoldMs?: number;
  /** Reorder window while such a hold is active, in packets. */
  retransmitWindowPackets?: number;
  /**
   * Sustained repeat requests per second. Heavy loss usually means a congested
   * uplink, and asking it to carry every lost packet twice makes that worse.
   * Beyond this budget a hole waits for the next token, longest-missing first,
   * and is ordinary loss if none comes while the mix can still hold it.
   */
  retransmitRequestsPerSecond?: number;
  /**
   * How long a sequence must stay missing before it is requested. Datagrams
   * that were merely reordered arrive within a few milliseconds; asking for
   * them spends the request budget and the uplink on audio already on its way.
   * The stream still holds for the hole from the moment it is noticed.
   */
  retransmitRequestDelayMs?: number;
};

export type AudioPacketRetransmitStats = {
  /** Distinct sequences whose repeat request actually left Relay. */
  requestedPackets: number;
  /** Requested sequences that arrived in time and were emitted in order. */
  recoveredPackets: number;
  /** Missing sequences that had to wait for request budget (some later got it). */
  budgetDeniedPackets: number;
  /** Requests sent again because the first repeat never arrived. */
  retriedPackets: number;
  /** Smoothed time from sending a first request to its repeat arriving. */
  repairRoundTripMs: number | null;
};

/** One sequence to ask for, and which attempt this is (0 = first). */
export type AudioPacketRetransmitRequest = { sequence: number; attempt: number };

type RetransmitRequestState = {
  /** Requests for this sequence that have left Relay. */
  attempts: number;
  /** Waiting for the caller to send it. */
  queued: boolean;
  dispatchedAtMs: number | null;
};

/** Upper bound on sequences requested per detected hole. */
const MAX_RETRANSMIT_REQUESTS_PER_HOLE = 32;
/** A quarter of a 100 packet/s datagram stream: isolated loss, not congestion. */
const DEFAULT_RETRANSMIT_REQUESTS_PER_SECOND = 25;
const DEFAULT_RETRANSMIT_REQUEST_DELAY_MS = 20;
/**
 * A repeat is a datagram like the one it replaces, so under loss it can be
 * lost too. One retry covers that; beyond it the path is too lossy for waiting
 * to pay, and the hole is ordinary loss.
 */
const MAX_RETRANSMIT_ATTEMPTS = 2;
/** Retry wait before any round trip has been measured. */
const DEFAULT_RETRANSMIT_RETRY_MS = 150;
const MIN_RETRANSMIT_RETRY_MS = 40;
const MAX_RETRANSMIT_RETRY_MS = 250;
/** Share of the request budget kept back from retries for fresh holes. */
const RETRANSMIT_RETRY_RESERVE_FRACTION = 0.2;
/** Never retry sooner than a couple of mixer ticks past the expected repeat. */
const MIN_RETRANSMIT_RETRY_MARGIN_MS = 20;

export type AudioPacketReceiverStats = {
  receivedPackets: number;
  emittedPackets: number;
  /** Cumulative source samples emitted as novel, ordered packets. */
  emittedSamples: number;
  lostPackets: number;
  reorderedPackets: number;
  duplicatePackets: number;
  latePackets: number;
  replayPackets: number;
  malformedPackets: number;
  wrongGenerationPackets: number;
  wrongSourcePackets: number;
  futurePackets: number;
  invalidSampleRangePackets: number;
  bufferedPackets: number;
};

type FinalizedState = 'emitted' | 'lost' | 'invalid';
type PendingPacket = { packet: AudioPacket; receivedAtMs: number };
type Counters = Omit<AudioPacketReceiverStats, 'bufferedPackets'>;
type ContinuitySnapshot = {
  expectedSequence: number;
  lastEmittedEndSampleIndex: number | null;
  pending: [number, PendingPacket][];
  finalized: [number, FinalizedState][];
  counters: Counters;
  updatedAtWallMs: number;
};

/**
 * The receiver currently carrying each source + capture generation, for a
 * replacement receiver to continue from. Only a replacement ever reads that
 * state, so it is copied when one is constructed: copying it after every
 * packet and every mixer flush, as this used to, was nearly all of the
 * receiver's work.
 */
const continuityOwners = new Map<string, AudioPacketReceiver>();

function continuityKey(source: AudioPacketSource, generation: number) {
  return `${source}:${generation >>> 0}`;
}

function sequenceDistance(from: number, to: number) {
  return (to - from) >>> 0;
}

function nextSequence(sequence: number) {
  return (sequence + 1) >>> 0;
}

function nonNegativeInteger(value: number) {
  return Number.isInteger(value) && value >= 0;
}

function uint32(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

/**
 * Converts unordered media packets into an ordered, bounded stream without
 * assigning them a new time. Missing sequences are transport evidence only;
 * the next packet's `firstSampleIndex` is what leaves the real timeline hole.
 *
 * A replacement receiver for the same source + capture generation, created
 * within a short reconnect window of the latest one's last activity, copies
 * that receiver's state and adopts it only when its
 * first valid packet proves capture continuation (non-zero sequence/time and a
 * forward sequence within the configured bound). A fresh capture beginning at
 * sequence 0 / sample 0 always resets the snapshot, so a coincidental generation
 * reuse cannot silently inherit another capture's frontier.
 *
 * A same-generation sender can legitimately advance farther than the ordinary
 * forward-jump guard after transport loss. One far-future packet is never
 * enough to move the frontier: resync requires two consecutive packets with a
 * non-decreasing sample timeline, and the candidate still has a finite second
 * forward bound. Replay and absurd sequence jumps remain rejected.
 *
 * If no in-process continuity snapshot exists and the caller did not provide an
 * explicit initial sequence, the first valid packet establishes the frontier.
 * That is the only sequence authority available after a Relay process restart:
 * the phone deliberately keeps its capture generation, sequence and sample
 * timeline across WebSocket reconnects.
 *
 * Reorder deadlines use the caller's monotonic media clock. Continuity expiry
 * deliberately uses wall time so socket replacement cannot compare unlike
 * clock domains (for example performance.now() against Date.now()).
 */
export class AudioPacketReceiver {
  readonly source: AudioPacketSource;
  readonly generation: number;
  readonly reorderWindowPackets: number;
  readonly reorderDeadlineMs: number;
  readonly maxForwardJumpPackets: number;

  private expectedSequence: number | null = null;
  private lastEmittedEndSampleIndex: number | null = null;
  private readonly pending = new Map<number, PendingPacket>();
  private readonly finalized = new Map<number, FinalizedState>();
  private readonly counters: Counters = {
    receivedPackets: 0,
    emittedPackets: 0,
    emittedSamples: 0,
    lostPackets: 0,
    reorderedPackets: 0,
    duplicatePackets: 0,
    latePackets: 0,
    replayPackets: 0,
    malformedPackets: 0,
    wrongGenerationPackets: 0,
    wrongSourcePackets: 0,
    futurePackets: 0,
    invalidSampleRangePackets: 0,
  };
  private continuityCandidate: ContinuitySnapshot | null = null;
  private continuityResolved = false;
  private readonly continuityKey: string;
  /** Wall time this receiver last changed the state a replacement would adopt. */
  private continuityUpdatedAtWallMs = -Infinity;
  private resyncCandidate: PendingPacket | null = null;
  readonly retransmitHoldMs: number;
  readonly retransmitWindowPackets: number;
  private retransmitHoldAllowed = false;
  private retransmitRequestsEnabled = true;
  /**
   * Sequences requested and not yet emitted or given up on, oldest first. A
   * request stays queued until the caller confirms it left Relay: a path that
   * vanishes between noticing a hole and sending the request must not lose it.
   */
  private readonly retransmitRequested = new Map<number, RetransmitRequestState>();
  /**
   * Missing sequences not requested yet, in the order they were noticed:
   * too young to request, or waiting for request budget.
   */
  private readonly retransmitCandidates = new Map<number, { noticedAtMs: number; denied: boolean }>();
  readonly retransmitRequestDelayMs: number;
  private readonly retransmitCounters = {
    requestedPackets: 0,
    recoveredPackets: 0,
    budgetDeniedPackets: 0,
    retriedPackets: 0,
  };
  /** Smoothed first-attempt repair round trip (request sent to repeat received). */
  private repairRoundTripMs: number | null = null;
  private repairRoundTripVariationMs = 0;
  readonly retransmitRequestsPerSecond: number;
  private retransmitTokens = 0;
  private retransmitTokensAtMs: number | null = null;

  constructor(options: AudioPacketReceiverOptions) {
    if (!nonNegativeInteger(options.reorderWindowPackets)) {
      throw new RangeError('reorderWindowPackets must be a non-negative integer');
    }
    if (!Number.isFinite(options.reorderDeadlineMs) || options.reorderDeadlineMs < 0) {
      throw new RangeError('reorderDeadlineMs must be non-negative');
    }
    if (!Number.isInteger(options.maxForwardJumpPackets) || options.maxForwardJumpPackets < 1) {
      throw new RangeError('maxForwardJumpPackets must be a positive integer');
    }
    if (options.reorderWindowPackets > options.maxForwardJumpPackets) {
      throw new RangeError('reorderWindowPackets cannot exceed maxForwardJumpPackets');
    }

    const initialSequence = options.initialSequence;
    if (initialSequence !== undefined && !uint32(initialSequence)) {
      throw new RangeError('initialSequence must be a uint32');
    }

    this.source = options.source;
    this.generation = options.generation >>> 0;
    this.expectedSequence = initialSequence === undefined ? null : initialSequence >>> 0;
    this.reorderWindowPackets = options.reorderWindowPackets;
    this.reorderDeadlineMs = options.reorderDeadlineMs;
    this.maxForwardJumpPackets = options.maxForwardJumpPackets;
    const retransmitHoldMs = options.retransmitHoldMs ?? 0;
    if (!Number.isFinite(retransmitHoldMs) || retransmitHoldMs < 0) {
      throw new RangeError('retransmitHoldMs must be non-negative');
    }
    const retransmitWindowPackets = options.retransmitWindowPackets ?? options.reorderWindowPackets;
    if (
      !nonNegativeInteger(retransmitWindowPackets)
      || retransmitWindowPackets > options.maxForwardJumpPackets
    ) {
      throw new RangeError('retransmitWindowPackets must be a non-negative integer within maxForwardJumpPackets');
    }
    this.retransmitHoldMs = retransmitHoldMs;
    this.retransmitWindowPackets = retransmitWindowPackets;
    const retransmitRequestsPerSecond = options.retransmitRequestsPerSecond
      ?? DEFAULT_RETRANSMIT_REQUESTS_PER_SECOND;
    if (!Number.isFinite(retransmitRequestsPerSecond) || retransmitRequestsPerSecond <= 0) {
      throw new RangeError('retransmitRequestsPerSecond must be positive');
    }
    this.retransmitRequestsPerSecond = retransmitRequestsPerSecond;
    const retransmitRequestDelayMs = options.retransmitRequestDelayMs
      ?? DEFAULT_RETRANSMIT_REQUEST_DELAY_MS;
    if (!Number.isFinite(retransmitRequestDelayMs) || retransmitRequestDelayMs < 0) {
      throw new RangeError('retransmitRequestDelayMs must be non-negative');
    }
    this.retransmitRequestDelayMs = retransmitRequestDelayMs;
    // Start with one second of budget so the first isolated losses are covered.
    this.retransmitTokens = retransmitRequestsPerSecond;

    this.continuityKey = continuityKey(this.source, this.generation);
    const wallNowMs = Date.now();
    AudioPacketReceiver.pruneContinuityOwners(wallNowMs);
    const owner = continuityOwners.get(this.continuityKey);
    if (owner && wallNowMs - owner.continuityUpdatedAtWallMs <= CONTINUITY_TTL_MS) {
      this.continuityCandidate = owner.continuitySnapshot();
    }
  }

  private static pruneContinuityOwners(wallNowMs: number) {
    for (const [key, owner] of continuityOwners) {
      if (wallNowMs - owner.continuityUpdatedAtWallMs > CONTINUITY_TTL_MS) {
        continuityOwners.delete(key);
      }
    }
    while (continuityOwners.size > MAX_CONTINUITY_SNAPSHOTS) {
      let leastRecentKey: string | null = null;
      let leastRecentAtMs = Infinity;
      for (const [key, owner] of continuityOwners) {
        if (owner.continuityUpdatedAtWallMs < leastRecentAtMs) {
          leastRecentAtMs = owner.continuityUpdatedAtWallMs;
          leastRecentKey = key;
        }
      }
      if (leastRecentKey === null) break;
      continuityOwners.delete(leastRecentKey);
    }
  }

  /** The state a replacement receiver adopts, copied so it cannot be shared. */
  private continuitySnapshot(): ContinuitySnapshot {
    return {
      expectedSequence: this.expectedSequence!,
      lastEmittedEndSampleIndex: this.lastEmittedEndSampleIndex,
      pending: [...this.pending.entries()].map(([sequence, pending]) => [sequence, {
        packet: pending.packet,
        receivedAtMs: pending.receivedAtMs,
      }]),
      finalized: [...this.finalized.entries()],
      counters: { ...this.counters },
      updatedAtWallMs: this.continuityUpdatedAtWallMs,
    };
  }

  receive(buffer: Buffer, nowMs = Date.now()): AudioPacket[] {
    this.counters.receivedPackets += 1;
    const decoded = decodeAudioPacket(buffer);
    if (!decoded.ok) {
      this.counters.malformedPackets += 1;
      if (this.continuityResolved) this.rememberContinuity();
      return [];
    }

    const packet = decoded.packet;
    if (packet.source !== this.source) {
      this.counters.wrongSourcePackets += 1;
      if (this.continuityResolved) this.rememberContinuity();
      return [];
    }
    if (packet.generation !== this.generation) {
      this.counters.wrongGenerationPackets += 1;
      if (this.continuityResolved) this.rememberContinuity();
      return [];
    }

    this.resolveContinuity(packet);
    this.noteRepeatArrival(packet.sequence, nowMs);

    if (this.pending.has(packet.sequence)) {
      this.counters.duplicatePackets += 1;
      this.rememberContinuity();
      return [];
    }

    const expectedSequence = this.expectedSequence;
    if (expectedSequence === null) throw new Error('receiver sequence origin is unavailable');
    const distance = sequenceDistance(expectedSequence, packet.sequence);
    if (distance === 0) {
      this.resyncCandidate = null;
      const output: AudioPacket[] = [];
      this.emitExpected(packet, output);
      this.drainPending(output);
      this.rememberContinuity();
      return output;
    }

    if (distance >= HALF_SEQUENCE_SPACE) {
      const finalized = this.finalized.get(packet.sequence);
      if (finalized === 'emitted') this.counters.duplicatePackets += 1;
      else if (finalized === 'lost' || finalized === 'invalid') this.counters.latePackets += 1;
      else this.counters.replayPackets += 1;
      this.rememberContinuity();
      return [];
    }

    if (distance > this.maxForwardJumpPackets) {
      this.counters.futurePackets += 1;
      const output = this.tryResync(packet, nowMs, distance);
      this.rememberContinuity();
      return output;
    }

    this.resyncCandidate = null;
    this.counters.reorderedPackets += 1;
    this.pending.set(packet.sequence, { packet, receivedAtMs: nowMs });
    this.requestMissingBefore(packet.sequence, nowMs);

    const output: AudioPacket[] = [];
    this.enforceWindow(packet.sequence, output);
    output.push(...this.flush(nowMs));
    this.rememberContinuity();
    return output;
  }

  flush(nowMs = Date.now()): AudioPacket[] {
    const output: AudioPacket[] = [];
    if (this.expectedSequence === null) return output;

    this.promoteRetransmitCandidates(nowMs);
    this.drainPending(output);
    while (this.pending.size > 0) {
      let oldestAt = Infinity;
      for (const pending of this.pending.values()) oldestAt = Math.min(oldestAt, pending.receivedAtMs);
      if (nowMs - oldestAt < this.currentDeadlineMs()) break;

      this.markExpectedLost();
      this.drainPending(output);
    }
    if (this.continuityResolved) this.rememberContinuity();
    return output;
  }

  stats(): AudioPacketReceiverStats {
    return { ...this.counters, bufferedPackets: this.pending.size };
  }

  retransmitStats(): AudioPacketRetransmitStats {
    return {
      ...this.retransmitCounters,
      repairRoundTripMs: this.repairRoundTripMs === null ? null : Math.round(this.repairRoundTripMs),
    };
  }

  /**
   * Whether a hole may keep holding the ordered stream, for a late arrival or
   * a requested repeat. The caller owns this answer because only the mix
   * knows how much buffered audio stands between the hole and the read head.
   * Withdrawing it releases a waiting hole on the next flush at the ordinary
   * reorder deadline.
   */
  setRetransmitHoldAllowed(allowed: boolean) {
    this.retransmitHoldAllowed = allowed;
  }

  /**
   * Whether the sender can answer repeat requests at all. A sender that keeps
   * no history is never asked, so its losses are not recorded as requests.
   */
  setRetransmitRequestsEnabled(enabled: boolean) {
    this.retransmitRequestsEnabled = enabled;
  }

  /**
   * Requests waiting to be sent, oldest first. Reading them does not consume
   * them: call `retransmitRequestsSent` once they have actually left Relay.
   */
  pendingRetransmitRequests(): AudioPacketRetransmitRequest[] {
    const requests: AudioPacketRetransmitRequest[] = [];
    for (const [sequence, state] of this.retransmitRequested) {
      if (state.queued) requests.push({ sequence, attempt: state.attempts });
    }
    return requests;
  }

  /** Marks requests from `pendingRetransmitRequests` as sent at `nowMs`. */
  retransmitRequestsSent(requests: readonly AudioPacketRetransmitRequest[], nowMs: number) {
    for (const { sequence, attempt } of requests) {
      const state = this.retransmitRequested.get(sequence);
      if (!state || !state.queued || state.attempts !== attempt) continue;
      if (state.attempts === 0) this.retransmitCounters.requestedPackets += 1;
      state.attempts += 1;
      state.queued = false;
      state.dispatchedAtMs = nowMs;
    }
  }

  /** Pending sequences, marked sent at once. For callers whose send cannot fail. */
  takeRetransmitRequests(nowMs = Date.now()): number[] {
    const requests = this.pendingRetransmitRequests();
    this.retransmitRequestsSent(requests, nowMs);
    return requests.map(({ sequence }) => sequence);
  }

  /**
   * How long to wait for a repeat before asking again: the smoothed round trip
   * plus four times its variation, as TCP sizes its retransmission timeout.
   * A retry is only useful while the hole still holds, which is a few hundred
   * milliseconds, so waiting a comfortable multiple of the round trip would
   * leave the second repeat arriving after the mix has moved on.
   */
  private retransmitRetryMs() {
    if (this.repairRoundTripMs === null) return DEFAULT_RETRANSMIT_RETRY_MS;
    return Math.min(
      MAX_RETRANSMIT_RETRY_MS,
      Math.max(
        MIN_RETRANSMIT_RETRY_MS,
        this.repairRoundTripMs
          + Math.max(MIN_RETRANSMIT_RETRY_MARGIN_MS, 4 * this.repairRoundTripVariationMs),
      ),
    );
  }

  /**
   * Round trip of a first request only: when a retried sequence arrives,
   * which request it answers is ambiguous (Karn), so it teaches nothing.
   */
  private noteRepeatArrival(sequence: number, nowMs: number) {
    const state = this.retransmitRequested.get(sequence);
    if (!state || state.attempts !== 1 || state.dispatchedAtMs === null) return;
    const sample = Math.max(0, nowMs - state.dispatchedAtMs);
    if (this.repairRoundTripMs === null) {
      this.repairRoundTripMs = sample;
      this.repairRoundTripVariationMs = sample / 2;
      return;
    }
    this.repairRoundTripVariationMs = this.repairRoundTripVariationMs * 0.75
      + Math.abs(this.repairRoundTripMs - sample) * 0.25;
    this.repairRoundTripMs = this.repairRoundTripMs * 0.875 + sample * 0.125;
  }

  /**
   * Any hole holds while the mix can afford it, not only a requested one.
   * Waiting is free until the read head gets close, and a packet that is
   * merely late (queueing jitter, a stalled radio, reordering) is heard if the
   * frontier waits for it, but lost for good if the frontier has moved on. A
   * repeat request is an extra way to fill the hole, not the reason to wait.
   */
  private retransmitHolding() {
    return this.retransmitHoldMs > 0
      && this.retransmitHoldAllowed
      && this.expectedSequence !== null
      && this.pending.size > 0;
  }

  private currentDeadlineMs() {
    return this.retransmitHolding()
      ? Math.max(this.reorderDeadlineMs, this.retransmitHoldMs)
      : this.reorderDeadlineMs;
  }

  private currentWindowPackets() {
    return this.retransmitHolding()
      ? Math.max(this.reorderWindowPackets, this.retransmitWindowPackets)
      : this.reorderWindowPackets;
  }

  /**
   * A packet arrived ahead of the frontier: every sequence between the
   * frontier and it that has not arrived is a candidate loss. It is requested
   * once it has stayed missing for the request delay; the sender answers from
   * its short history or not at all.
   */
  private requestMissingBefore(sequence: number, nowMs: number) {
    if (
      this.retransmitHoldMs <= 0
      || !this.retransmitRequestsEnabled
      || this.expectedSequence === null
    ) return;

    const distance = sequenceDistance(this.expectedSequence, sequence);
    const first = distance > MAX_RETRANSMIT_REQUESTS_PER_HOLE
      ? (sequence - MAX_RETRANSMIT_REQUESTS_PER_HOLE) >>> 0
      : this.expectedSequence;
    for (let candidate = first; candidate !== sequence; candidate = nextSequence(candidate)) {
      if (
        this.pending.has(candidate)
        || this.retransmitRequested.has(candidate)
        || this.retransmitCandidates.has(candidate)
      ) continue;
      this.retransmitCandidates.set(candidate, { noticedAtMs: nowMs, denied: false });
    }
    // Candidates and requests normally retire as the frontier emits or
    // abandons them. Bound the bookkeeping anyway so no sender behaviour can
    // grow it without limit.
    for (const tracked of [this.retransmitCandidates, this.retransmitRequested]) {
      while (tracked.size > this.maxForwardJumpPackets) {
        const oldest = tracked.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        tracked.delete(oldest);
      }
    }
    this.promoteRetransmitCandidates(nowMs);
  }

  private promoteRetransmitCandidates(nowMs: number) {
    if (this.retransmitCandidates.size === 0 && this.retransmitRequested.size === 0) return;
    if (this.retransmitTokensAtMs !== null && nowMs > this.retransmitTokensAtMs) {
      this.retransmitTokens = Math.min(
        this.retransmitRequestsPerSecond,
        this.retransmitTokens
          + ((nowMs - this.retransmitTokensAtMs) * this.retransmitRequestsPerSecond) / 1000,
      );
    }
    this.retransmitTokensAtMs = nowMs;

    // Oldest first. When the budget runs short, a hole keeps its place instead
    // of being dropped: a packet that was only reordered fills its hole by
    // itself within the jitter spread, so the holes still waiting for the next
    // token are the ones really lost. On a jittery path this spends the budget
    // on real loss rather than on the reordering that happens to be youngest.
    for (const [candidate, entry] of this.retransmitCandidates) {
      if (this.pending.has(candidate)) {
        this.retransmitCandidates.delete(candidate);
        continue;
      }
      if (nowMs - entry.noticedAtMs < this.retransmitRequestDelayMs) continue;
      if (!this.retransmitRequestsEnabled) {
        this.retransmitCandidates.delete(candidate);
        continue;
      }
      if (this.retransmitTokens < 1) {
        if (!entry.denied) {
          entry.denied = true;
          this.retransmitCounters.budgetDeniedPackets += 1;
        }
        continue;
      }
      this.retransmitCandidates.delete(candidate);
      this.retransmitTokens -= 1;
      this.retransmitRequested.set(candidate, { attempts: 0, queued: true, dispatchedAtMs: null });
    }

    // A request whose repeat has not arrived within the retry timeout was
    // lost itself, or its repeat was. Ask once more while the hole still holds,
    // but only from spare budget: when loss is heavy enough to drain it, a
    // first request for a fresh hole is the better use of each token.
    if (!this.retransmitRequestsEnabled) return;
    const retryReserve = this.retransmitRequestsPerSecond * RETRANSMIT_RETRY_RESERVE_FRACTION;
    const retryMs = this.retransmitRetryMs();
    for (const state of this.retransmitRequested.values()) {
      if (
        state.queued
        || state.dispatchedAtMs === null
        || state.attempts >= MAX_RETRANSMIT_ATTEMPTS
        || nowMs - state.dispatchedAtMs < retryMs
      ) continue;
      if (this.retransmitTokens < 1 + retryReserve) break;
      this.retransmitTokens -= 1;
      state.queued = true;
      this.retransmitCounters.retriedPackets += 1;
    }
  }

  private resolveContinuity(packet: AudioPacket) {
    if (this.continuityResolved) return;
    this.continuityResolved = true;

    const candidate = this.continuityCandidate;
    this.continuityCandidate = null;
    if (!candidate) {
      if (this.expectedSequence === null) this.expectedSequence = packet.sequence;
      this.rememberContinuity();
      return;
    }

    const definitelyFresh = packet.sequence === 0 && packet.firstSampleIndex === 0;
    const forwardDistance = sequenceDistance(candidate.expectedSequence, packet.sequence);
    const timelineContinues = candidate.lastEmittedEndSampleIndex === null
      ? packet.sequence !== 0 || packet.firstSampleIndex !== 0
      : packet.firstSampleIndex >= candidate.lastEmittedEndSampleIndex;
    const sequenceContinues = forwardDistance < HALF_SEQUENCE_SPACE
      && forwardDistance <= this.maxForwardJumpPackets;

    if (!definitelyFresh && timelineContinues && sequenceContinues) {
      const currentReceivedPackets = this.counters.receivedPackets;
      const currentMalformedPackets = this.counters.malformedPackets;
      const currentWrongGenerationPackets = this.counters.wrongGenerationPackets;
      const currentWrongSourcePackets = this.counters.wrongSourcePackets;

      this.expectedSequence = candidate.expectedSequence;
      this.lastEmittedEndSampleIndex = candidate.lastEmittedEndSampleIndex;
      this.pending.clear();
      for (const [sequence, pending] of candidate.pending) this.pending.set(sequence, pending);
      this.finalized.clear();
      for (const [sequence, state] of candidate.finalized) this.finalized.set(sequence, state);
      Object.assign(this.counters, candidate.counters);
      this.counters.receivedPackets += currentReceivedPackets;
      this.counters.malformedPackets += currentMalformedPackets;
      this.counters.wrongGenerationPackets += currentWrongGenerationPackets;
      this.counters.wrongSourcePackets += currentWrongSourcePackets;
    } else {
      continuityOwners.delete(this.continuityKey);
      if (this.expectedSequence === null) this.expectedSequence = packet.sequence;
    }

    this.rememberContinuity();
  }

  private tryResync(packet: AudioPacket, nowMs: number, distance: number): AudioPacket[] {
    const maxResyncDistance = Math.min(
      HALF_SEQUENCE_SPACE - 1,
      this.maxForwardJumpPackets * RESYNC_FORWARD_WINDOW_MULTIPLIER,
    );
    if (distance > maxResyncDistance) {
      this.resyncCandidate = null;
      return [];
    }

    if (
      this.lastEmittedEndSampleIndex !== null
      && packet.firstSampleIndex < this.lastEmittedEndSampleIndex
    ) {
      this.resyncCandidate = null;
      return [];
    }

    const candidate = this.resyncCandidate;
    if (
      candidate
      && packet.sequence === nextSequence(candidate.packet.sequence)
      && packet.firstSampleIndex >= candidate.packet.firstSampleIndex + candidate.packet.sampleCount
    ) {
      const output: AudioPacket[] = [];
      this.pending.clear();
      // Everything behind a resync is abandoned, including requested repeats.
      this.retransmitRequested.clear();
      this.retransmitCandidates.clear();
      this.expectedSequence = candidate.packet.sequence;
      this.resyncCandidate = null;
      this.emitExpected(candidate.packet, output);
      this.emitExpected(packet, output);
      return output;
    }

    this.resyncCandidate = { packet, receivedAtMs: nowMs };
    return [];
  }

  /** Makes this receiver the one a replacement for its capture continues from. */
  private rememberContinuity() {
    if (this.expectedSequence === null) return;
    this.continuityUpdatedAtWallMs = Date.now();
    if (continuityOwners.get(this.continuityKey) === this) return;
    continuityOwners.delete(this.continuityKey);
    continuityOwners.set(this.continuityKey, this);
    AudioPacketReceiver.pruneContinuityOwners(this.continuityUpdatedAtWallMs);
  }

  private enforceWindow(newestSequence: number, output: AudioPacket[]) {
    if (this.expectedSequence === null) return;

    let distance = sequenceDistance(this.expectedSequence, newestSequence);
    while (distance > this.currentWindowPackets()) {
      this.markExpectedLost();
      this.drainPending(output);
      if (this.expectedSequence === null) return;
      distance = sequenceDistance(this.expectedSequence, newestSequence);
      if (distance >= HALF_SEQUENCE_SPACE) return;
    }
  }

  private drainPending(output: AudioPacket[]) {
    while (this.expectedSequence !== null) {
      const pending = this.pending.get(this.expectedSequence);
      if (!pending) return;
      this.pending.delete(this.expectedSequence);
      this.emitExpected(pending.packet, output);
    }
  }

  private emitExpected(packet: AudioPacket, output: AudioPacket[]) {
    const sequence = packet.sequence;
    const expected = this.expectedSequence;
    if (expected === null || sequence !== expected) throw new Error('receiver emitted a non-frontier packet');

    const end = packet.firstSampleIndex + packet.sampleCount;
    if (
      this.lastEmittedEndSampleIndex !== null
      && packet.firstSampleIndex < this.lastEmittedEndSampleIndex
    ) {
      this.counters.invalidSampleRangePackets += 1;
      this.rememberFinalized(sequence, 'invalid');
      this.expectedSequence = nextSequence(sequence);
      return;
    }

    output.push(packet);
    if ((this.retransmitRequested.get(sequence)?.attempts ?? 0) > 0) {
      this.retransmitCounters.recoveredPackets += 1;
    }
    this.retransmitRequested.delete(sequence);
    this.retransmitCandidates.delete(sequence);
    this.counters.emittedPackets += 1;
    this.counters.emittedSamples = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.counters.emittedSamples + packet.sampleCount,
    );
    this.lastEmittedEndSampleIndex = end;
    this.rememberFinalized(sequence, 'emitted');
    this.expectedSequence = nextSequence(sequence);
  }

  private markExpectedLost() {
    if (this.expectedSequence === null) return;
    const sequence = this.expectedSequence;
    this.retransmitRequested.delete(sequence);
    this.retransmitCandidates.delete(sequence);
    this.counters.lostPackets += 1;
    this.rememberFinalized(sequence, 'lost');
    this.expectedSequence = nextSequence(sequence);
  }

  private rememberFinalized(sequence: number, state: FinalizedState) {
    this.finalized.delete(sequence);
    this.finalized.set(sequence, state);
    while (this.finalized.size > this.maxForwardJumpPackets) {
      const oldest = this.finalized.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.finalized.delete(oldest);
    }
  }
}
