import { FRAME_MAGIC } from './pcm-frame.js';
import {
  AUDIO_PACKET_HEADER_BYTES, AUDIO_PACKET_VERSION, decodeAudioPacket,
} from './audio-packet.js';
import type { ChoirFreshCaptureTicket } from './choir-fresh-room-handshake-experiment.js';
import type { ChoirRoomRestartCoordinatorExperiment } from './choir-room-restart-coordinator-experiment.js';

/**
 * PRIVATE, experimental, *secondary-only* WebSocket PCM adapter.
 *
 * It cannot grant a ticket: an already trusted SERVER authorization flow
 * must call bindVerifiedSecondary() with a ticket issued by the restart
 * coordinator. The live server admits B only through an authenticated
 * one-use AudioPacket v2 claim. No client JSON grants media authority.
 *
 * Attached sockets are consumed even on malformed/stale input so a choir
 * packet can NEVER fall through to the existing N=1 Mic/Robot path.
 */
type ChoirSecondarySocket = object & {
  participantId?: string;
  role: string;
};

type BoundSecondary = {
  ticket: ChoirFreshCaptureTicket;
  sampleRate: number;
  generation: number | null;
  packetWindowStartMs: number;
  packetCount: number;
  /** v2 committed sequence identity, bounded to the recent reorder horizon. */
  latestSequence: number | null;
  seenSequences: Map<number, { start: number; end: number }>;
};

export type ChoirIngressResult =
  | { intercepted: false }
  | { intercepted: true; accepted: boolean; reason:
      'accepted' | 'malformed-frame' | 'too-large' | 'rate-limited'
      | 'stale-authority' | 'socket-identity-changed' | 'capture-restarted'
      | 'duplicate-packet' | 'sequence-out-of-window' | 'sample-overlap' };

export class ChoirSecondaryPcmIngressExperiment {
  private readonly sockets = new WeakMap<ChoirSecondarySocket, BoundSecondary>();
  /** One physical socket per server-issued transport identity at a time. */
  private readonly transportBindings = new Map<string, ChoirSecondarySocket>();
  private readonly maxFrameBytes: number;
  /** v2 replay/reorder horizon: no unbounded sequence maps. */
  private static readonly MAX_REORDER_SEQUENCES = 128;

  /**
   * Every frame the duet room accepted, after the same checks, so the room
   * output can mix this singer too. Rejected frames never reach it.
   */
  /** What happened to B's frames, for /statusz: a silent B is otherwise a mystery. */
  readonly counts = { accepted: 0, rejected: {} as Record<string, number>, lastRejected: null as string | null };

  onAcceptedFrame: ((frame: { generation: number; firstSampleIndex: number; pcm: Buffer },
    sampleRate: number, participantId: string, nowMs: number) => void) | null = null;

  constructor(
    private readonly coordinator: Pick<ChoirRoomRestartCoordinatorExperiment,
      'mayAcceptVerifiedTicket' | 'receiveVerifiedMic' | 'disconnectVerifiedSinger'>,
    private readonly isSocketOpen: (socket: ChoirSecondarySocket) => boolean,
    maxPacketMs = 200,
  ) {
    if (!Number.isSafeInteger(maxPacketMs) || maxPacketMs <= 0 || maxPacketMs > 1_000)
      throw new RangeError('Invalid Choir packet duration');
    // 192kHz * maxPacketMs * 2 bytes + largest supported PCM header.
    this.maxFrameBytes = AUDIO_PACKET_HEADER_BYTES
      + Math.ceil(192_000 * maxPacketMs / 1_000) * 2;
    this.maxPacketMs = maxPacketMs;
  }
  private readonly maxPacketMs: number;

  /**
   * Ticket must already have been issued by the server's trusted A/B admission.
   * The authenticated socket identity is checked again on every binary frame.
   * A production publisher, backing source or monitor socket cannot double as
   * a Choir secondary transport.
   */
  bindVerifiedSecondary(
    socket: ChoirSecondarySocket,
    ticket: ChoirFreshCaptureTicket,
    sourceRate: number,
    nowMs: number,
  ): boolean {
    if (this.sockets.has(socket) || this.transportBindings.has(ticket.transportId)
      || !this.isSocketOpen(socket)
      || socket.role !== 'unknown'
      || !socket.participantId || socket.participantId !== ticket.participantId
      || ticket.seat !== 'secondary'
      || !Number.isSafeInteger(ticket.roomEpoch) || ticket.roomEpoch < 1
      || !Number.isSafeInteger(ticket.songEpoch) || ticket.songEpoch < 1
      || !Number.isSafeInteger(ticket.mediaEpoch) || ticket.mediaEpoch < 1
      || !ticket.transportId || ticket.transportId !== ticket.transportId.trim()
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000
      || !Number.isFinite(nowMs) || nowMs < 0
      || !this.coordinator.mayAcceptVerifiedTicket(ticket, nowMs)) return false;

    this.sockets.set(socket, {
      ticket, sampleRate: sourceRate, generation: null,
      packetWindowStartMs: nowMs, packetCount: 0,
      latestSequence: null, seenSequences: new Map(),
    });
    this.transportBindings.set(ticket.transportId, socket);
    return true;
  }

  /** Called ahead of ALL regular production media routes. */
  interceptBinary(socket: ChoirSecondarySocket, bytes: Buffer, nowMs: number):
    ChoirIngressResult {
    const bound = this.sockets.get(socket);
    if (!bound) return { intercepted: false };
    const rejected = (reason: Exclude<ChoirIngressResult, { intercepted: false }>['reason']):
      ChoirIngressResult => {
      this.counts.rejected[reason] = (this.counts.rejected[reason] ?? 0) + 1;
      this.counts.lastRejected = reason;
      return { intercepted: true, accepted: false, reason };
    };
    if (!this.isSocketOpen(socket) || socket.role !== 'unknown'
      || socket.participantId !== bound.ticket.participantId)
      return rejected('socket-identity-changed');

    // No unbounded per-socket PCM aggregation, independent of the global
    // Relay WebSocket's existing 1MB max payload guard.
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxFrameBytes
      || bytes.length < AUDIO_PACKET_HEADER_BYTES + 2)
      return rejected('too-large');
    // This experimental ingress has exactly one wire format: AudioPacket v2
    // MIC PCM. Never autodetect v1 or Opus v3, even on malformed frames.
    if (bytes.readUInt16LE(0) !== FRAME_MAGIC
      || bytes.readUInt8(2) !== AUDIO_PACKET_VERSION) return rejected('malformed-frame');

    // Bound ingress traffic even if a future malformed/duplicate sender tries
    // hundreds of retransmitted frames inside a single wall-clock second.
    if (!Number.isFinite(nowMs) || nowMs < bound.packetWindowStartMs)
      return rejected('stale-authority');
    if (nowMs - bound.packetWindowStartMs >= 1_000) {
      bound.packetWindowStartMs = nowMs;
      bound.packetCount = 0;
    }
    if (++bound.packetCount > 150) return rejected('rate-limited');

    const decoded = decodeAudioPacket(bytes);
    if (!decoded.ok || decoded.packet.source !== 'mic')
      return rejected('malformed-frame');
    const packet = decoded.packet;
    if (packet.sampleCount > Math.ceil(bound.sampleRate * this.maxPacketMs / 1_000))
      return rejected('too-large');
    const sequence = packet.sequence;
    const frame = {
      generation: packet.generation,
      firstSampleIndex: packet.firstSampleIndex,
      pcm: packet.pcm,
    };

    const sampleCount = frame.pcm.length / 2;
    if (!Number.isSafeInteger(frame.firstSampleIndex)
      || frame.generation === null
      || !Number.isSafeInteger(frame.generation) || frame.generation < 0
      || frame.firstSampleIndex === null || frame.firstSampleIndex < 0
      || sampleCount < 1 || sampleCount > Math.ceil(bound.sampleRate * this.maxPacketMs / 1_000)
      || !Number.isSafeInteger(frame.firstSampleIndex + sampleCount))
      return rejected('malformed-frame');
    if (bound.generation !== null && frame.generation !== bound.generation)
      return rejected('capture-restarted');

    {
      const latest = bound.latestSequence;
      if (bound.seenSequences.has(sequence)) return rejected('duplicate-packet');
      if (latest !== null) {
        const forward = (sequence - latest) >>> 0;
        const backward = (latest - sequence) >>> 0;
        const horizon = ChoirSecondaryPcmIngressExperiment.MAX_REORDER_SEQUENCES;
        // Modular uint32 ordering: allow bounded retransmission/reorder and
        // ordinary wraparound, but not arbitrarily old/far-future claims.
        if (forward === 0) return rejected('duplicate-packet');
        if (forward < 0x8000_0000) {
          if (forward > 4 * horizon) return rejected('sequence-out-of-window');
        } else if (backward > horizon) {
          return rejected('sequence-out-of-window');
        }
      }
      const start = frame.firstSampleIndex!;
      const end = start + sampleCount;
      for (const window of bound.seenSequences.values()) {
        if (start < window.end && end > window.start)
          return rejected('sample-overlap');
      }
    }
    const accepted = this.coordinator.receiveVerifiedMic(
      bound.ticket, frame, bound.sampleRate, nowMs,
    );
    if (!accepted) {
      this.releaseTransportBinding(socket, bound.ticket.transportId);
      return rejected('stale-authority');
    }
    bound.generation = frame.generation;
    this.onAcceptedFrame?.({
      generation: frame.generation, firstSampleIndex: frame.firstSampleIndex!, pcm: frame.pcm,
    }, bound.sampleRate, bound.ticket.participantId, nowMs);
    {
      const latest = bound.latestSequence;
      if (latest === null || ((sequence - latest) >>> 0) < 0x8000_0000)
        bound.latestSequence = sequence;
      bound.seenSequences.set(sequence, {
        start: frame.firstSampleIndex!, end: frame.firstSampleIndex! + sampleCount,
      });
      const current = bound.latestSequence!;
      for (const previous of bound.seenSequences.keys()) {
        if (((current - previous) >>> 0)
          > ChoirSecondaryPcmIngressExperiment.MAX_REORDER_SEQUENCES)
          bound.seenSequences.delete(previous);
      }
    }
    this.counts.accepted += 1;
    return { intercepted: true, accepted: true, reason: 'accepted' };
  }

  /** Retire a transport ownership claim without making its old socket PCM fall through. */
  private releaseTransportBinding(socket: ChoirSecondarySocket, transportId: string) {
    if (this.transportBindings.get(transportId) === socket)
      this.transportBindings.delete(transportId);
  }

  /** Bounded periodic cleanup when the trusted room changes but old B is silent. */
  sweepStale(nowMs: number): number {
    let released = 0;
    for (const [transportId, socket] of this.transportBindings) {
      const bound = this.sockets.get(socket);
      if (!bound || !this.isSocketOpen(socket)
        || !this.coordinator.mayAcceptVerifiedTicket(bound.ticket, nowMs)) {
        this.releaseTransportBinding(socket, transportId);
        released++;
      }
    }
    return released;
  }

  /** A physical close revokes its exact admitted transport, never another Mic. */
  disconnect(socket: ChoirSecondarySocket, nowMs: number): boolean {
    const bound = this.sockets.get(socket);
    if (!bound) return false;
    this.sockets.delete(socket);
    this.releaseTransportBinding(socket, bound.ticket.transportId);
    return this.coordinator.disconnectVerifiedSinger(bound.ticket, nowMs);
  }

  isAttached(socket: ChoirSecondarySocket): boolean {
    return this.sockets.has(socket);
  }
}
