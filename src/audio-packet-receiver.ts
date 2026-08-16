import {
  decodeAudioPacket,
  type AudioPacket,
  type AudioPacketSource,
} from './audio-packet.js';

const HALF_SEQUENCE_SPACE = 0x8000_0000;

export type AudioPacketReceiverOptions = {
  source: AudioPacketSource;
  generation: number;
  /** First sequence authorized for this capture. Fresh browser captures start at zero. */
  initialSequence?: number;
  reorderWindowPackets: number;
  reorderDeadlineMs: number;
  maxForwardJumpPackets: number;
};

export type AudioPacketReceiverStats = {
  receivedPackets: number;
  emittedPackets: number;
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

    const initialSequence = options.initialSequence ?? 0;
    if (!uint32(initialSequence)) throw new RangeError('initialSequence must be a uint32');

    this.source = options.source;
    this.generation = options.generation >>> 0;
    this.expectedSequence = initialSequence >>> 0;
    this.reorderWindowPackets = options.reorderWindowPackets;
    this.reorderDeadlineMs = options.reorderDeadlineMs;
    this.maxForwardJumpPackets = options.maxForwardJumpPackets;
  }

  receive(buffer: Buffer, nowMs = Date.now()): AudioPacket[] {
    this.counters.receivedPackets += 1;
    const decoded = decodeAudioPacket(buffer);
    if (!decoded.ok) {
      this.counters.malformedPackets += 1;
      return [];
    }

    const packet = decoded.packet;
    if (packet.source !== this.source) {
      this.counters.wrongSourcePackets += 1;
      return [];
    }
    if (packet.generation !== this.generation) {
      this.counters.wrongGenerationPackets += 1;
      return [];
    }

    if (this.pending.has(packet.sequence)) {
      this.counters.duplicatePackets += 1;
      return [];
    }

    const expectedSequence = this.expectedSequence;
    if (expectedSequence === null) throw new Error('receiver sequence origin is unavailable');
    const distance = sequenceDistance(expectedSequence, packet.sequence);
    if (distance === 0) {
      const output: AudioPacket[] = [];
      this.emitExpected(packet, output);
      this.drainPending(output);
      return output;
    }

    if (distance >= HALF_SEQUENCE_SPACE) {
      const finalized = this.finalized.get(packet.sequence);
      if (finalized === 'emitted') this.counters.duplicatePackets += 1;
      else if (finalized === 'lost' || finalized === 'invalid') this.counters.latePackets += 1;
      else this.counters.replayPackets += 1;
      return [];
    }

    if (distance > this.maxForwardJumpPackets) {
      this.counters.futurePackets += 1;
      return [];
    }

    this.counters.reorderedPackets += 1;
    this.pending.set(packet.sequence, { packet, receivedAtMs: nowMs });

    const output: AudioPacket[] = [];
    this.enforceWindow(packet.sequence, output);
    output.push(...this.flush(nowMs));
    return output;
  }

  flush(nowMs = Date.now()): AudioPacket[] {
    const output: AudioPacket[] = [];
    if (this.expectedSequence === null) return output;

    this.drainPending(output);
    while (this.pending.size > 0) {
      let oldestAt = Infinity;
      for (const pending of this.pending.values()) oldestAt = Math.min(oldestAt, pending.receivedAtMs);
      if (nowMs - oldestAt < this.reorderDeadlineMs) break;

      this.markExpectedLost();
      this.drainPending(output);
    }
    return output;
  }

  stats(): AudioPacketReceiverStats {
    return { ...this.counters, bufferedPackets: this.pending.size };
  }

  private enforceWindow(newestSequence: number, output: AudioPacket[]) {
    if (this.expectedSequence === null) return;

    let distance = sequenceDistance(this.expectedSequence, newestSequence);
    while (distance > this.reorderWindowPackets) {
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
    this.counters.emittedPackets += 1;
    this.lastEmittedEndSampleIndex = end;
    this.rememberFinalized(sequence, 'emitted');
    this.expectedSequence = nextSequence(sequence);
  }

  private markExpectedLost() {
    if (this.expectedSequence === null) return;
    const sequence = this.expectedSequence;
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
