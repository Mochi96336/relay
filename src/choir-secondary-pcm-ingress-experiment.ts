import { OpusMicDecoder } from './opus-mic-decoder.js';
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
 *
 * A bound socket carries B's live voice for as long as B's join allows it
 * (liveVoiceAllowed), song or no song. While a duet room is up, it also holds
 * that room's ticket and feeds the room's evidence; a retired room drops the
 * ticket, not the socket, and the next room is attached to the same socket
 * (attachRoomTicket). Without liveVoiceAllowed a socket lives and dies with
 * its room, as before.
 *
 * A socket speaks exactly the one wire format it registered with: AudioPacket
 * v2 PCM at its native rate, or Opus v3 (20 ms at 48 kHz, as the main Mic
 * sends). Opus is decoded here, in arrival order, so everything after this
 * point sees PCM frames either way.
 */
type ChoirSecondarySocket = object & {
  participantId?: string;
  role: string;
};

type BoundSecondary = {
  participantId: string;
  /** Server-generated identity of this socket; a room ticket names the same one. */
  transportId: string;
  /** The current duet room's ticket, or null between rooms. */
  ticket: ChoirFreshCaptureTicket | null;
  sampleRate: number;
  generation: number | null;
  packetWindowStartMs: number;
  packetCount: number;
  /** v2 committed sequence identity, bounded to the recent reorder horizon. */
  latestSequence: number | null;
  seenSequences: Map<number, { start: number; end: number }>;
  /** Opus v3 sockets only: the decoder (null until the first packet, or after corrupt data). */
  opus: { decoder: OpusMicDecoder | null } | null;
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

  /** The wire format B's bound socket sends, or null while none is bound. */
  get codec(): 'pcm' | 'opus' | null {
    for (const socket of this.transportBindings.values()) {
      const bound = this.sockets.get(socket);
      if (bound) return bound.opus ? 'opus' : 'pcm';
    }
    return null;
  }

  /**
   * Whether B's join lets B be heard without a duet room: B is the joined
   * singer and the singer B joined still holds the Mic. Null keeps every
   * socket room-only.
   */
  liveVoiceAllowed: ((participantId: string, nowMs: number) => boolean) | null = null;

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
    packetVersion: 2 | 3 = 2,
  ): boolean {
    if (!this.validTicket(ticket)
      || !this.mayBind(socket, ticket.participantId, ticket.transportId, sourceRate, nowMs, packetVersion)
      || !this.coordinator.mayAcceptVerifiedTicket(ticket, nowMs)) return false;
    this.bind(socket, ticket.participantId, ticket.transportId, ticket, sourceRate, nowMs, packetVersion);
    return true;
  }

  /**
   * B's media socket admitted by B's join alone, while no duet room is up.
   * `transportId` is server-generated; a later room admits B under it.
   */
  bindJoinedSecondary(
    socket: ChoirSecondarySocket,
    participantId: string,
    transportId: string,
    sourceRate: number,
    nowMs: number,
    packetVersion: 2 | 3 = 2,
  ): boolean {
    if (!this.mayBind(socket, participantId, transportId, sourceRate, nowMs, packetVersion)
      || this.liveVoiceAllowed?.(participantId, nowMs) !== true) return false;
    this.bind(socket, participantId, transportId, null, sourceRate, nowMs, packetVersion);
    return true;
  }

  /**
   * Puts B's already-bound socket into a new duet room. The ticket must name
   * that socket's transport and singer, and the socket must be between rooms.
   */
  attachRoomTicket(ticket: ChoirFreshCaptureTicket, nowMs: number): boolean {
    const socket = this.transportBindings.get(ticket.transportId);
    const bound = socket ? this.sockets.get(socket) : undefined;
    if (!socket || !bound || bound.ticket !== null || !this.isSocketOpen(socket)
      || bound.participantId !== ticket.participantId || !this.validTicket(ticket)
      || !this.coordinator.mayAcceptVerifiedTicket(ticket, nowMs)) return false;
    bound.ticket = ticket;
    return true;
  }

  /** The transport of B's open socket, room or not; null when B has none. */
  liveTransportFor(participantId: string): string | null {
    for (const [transportId, socket] of this.transportBindings) {
      if (this.sockets.get(socket)?.participantId === participantId && this.isSocketOpen(socket))
        return transportId;
    }
    return null;
  }

  private validTicket(ticket: ChoirFreshCaptureTicket) {
    return ticket.seat === 'secondary'
      && Number.isSafeInteger(ticket.roomEpoch) && ticket.roomEpoch >= 1
      && Number.isSafeInteger(ticket.songEpoch) && ticket.songEpoch >= 1
      && Number.isSafeInteger(ticket.mediaEpoch) && ticket.mediaEpoch >= 1;
  }

  private mayBind(socket: ChoirSecondarySocket, participantId: string, transportId: string,
    sourceRate: number, nowMs: number, packetVersion: 2 | 3) {
    return !this.sockets.has(socket) && !this.transportBindings.has(transportId)
      && (packetVersion === 2 || (packetVersion === 3 && sourceRate === 48_000))
      && this.isSocketOpen(socket)
      && socket.role === 'unknown'
      && Boolean(participantId) && socket.participantId === participantId
      && Boolean(transportId) && transportId === transportId.trim()
      && Number.isInteger(sourceRate) && sourceRate >= 8_000 && sourceRate <= 192_000
      && Number.isFinite(nowMs) && nowMs >= 0;
  }

  private bind(socket: ChoirSecondarySocket, participantId: string, transportId: string,
    ticket: ChoirFreshCaptureTicket | null, sourceRate: number, nowMs: number, packetVersion: 2 | 3) {
    this.sockets.set(socket, {
      participantId, transportId, ticket, sampleRate: sourceRate, generation: null,
      packetWindowStartMs: nowMs, packetCount: 0,
      latestSequence: null, seenSequences: new Map(),
      opus: packetVersion === 3 ? { decoder: null } : null,
    });
    this.transportBindings.set(transportId, socket);
  }

  /**
   * Whether this socket may still carry B: its room still takes it, or B's
   * join lets B be heard without one. A room that no longer takes it is let
   * go here, so the next room can attach.
   */
  private stillAuthorized(bound: BoundSecondary, nowMs: number) {
    if (bound.ticket && !this.coordinator.mayAcceptVerifiedTicket(bound.ticket, nowMs)) bound.ticket = null;
    return bound.ticket !== null || this.liveVoiceAllowed?.(bound.participantId, nowMs) === true;
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
      || socket.participantId !== bound.participantId)
      return rejected('socket-identity-changed');

    // No unbounded per-socket PCM aggregation, independent of the global
    // Relay WebSocket's existing 1MB max payload guard.
    if (!Buffer.isBuffer(bytes) || bytes.length > this.maxFrameBytes
      || bytes.length < AUDIO_PACKET_HEADER_BYTES + 2)
      return rejected('too-large');
    // Exactly the wire format this socket registered: AudioPacket v2 MIC PCM
    // or Opus v3. Never autodetect, even on malformed frames.
    if (bytes.readUInt16LE(0) !== FRAME_MAGIC
      || bytes.readUInt8(2) !== (bound.opus ? 3 : AUDIO_PACKET_VERSION)) return rejected('malformed-frame');

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
    // Opus state follows every packet decoded, so a duplicate or another
    // capture's packet must be refused before it reaches the decoder.
    if (bound.opus && bound.seenSequences.has(sequence)) return rejected('duplicate-packet');
    if (bound.opus && bound.generation !== null && packet.generation !== bound.generation)
      return rejected('capture-restarted');
    const frame = bound.opus
      ? decodeOpusFrame(bound.opus, packet)
      : { generation: packet.generation, firstSampleIndex: packet.firstSampleIndex, pcm: packet.pcm };
    if (!frame) return rejected('malformed-frame');

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
    // The room takes the frame as evidence when one is up; B's join decides
    // whether it is heard between rooms.
    const inRoom = bound.ticket !== null
      && this.coordinator.receiveVerifiedMic(bound.ticket, frame, bound.sampleRate, nowMs);
    // Only a room that is gone lets go of the socket; a frame it merely
    // refused leaves B in it.
    if (!inRoom && bound.ticket && !this.coordinator.mayAcceptVerifiedTicket(bound.ticket, nowMs))
      bound.ticket = null;
    if (!inRoom && this.liveVoiceAllowed?.(bound.participantId, nowMs) !== true) {
      this.releaseTransportBinding(socket, bound.transportId);
      return rejected('stale-authority');
    }
    bound.generation = frame.generation;
    this.onAcceptedFrame?.({
      generation: frame.generation, firstSampleIndex: frame.firstSampleIndex!, pcm: frame.pcm,
    }, bound.sampleRate, bound.participantId, nowMs);
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
      if (!bound || !this.isSocketOpen(socket) || !this.stillAuthorized(bound, nowMs)) {
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
    this.releaseTransportBinding(socket, bound.transportId);
    // Whether a room singer was revoked; between rooms there is none.
    return bound.ticket ? this.coordinator.disconnectVerifiedSinger(bound.ticket, nowMs) : false;
  }

  isAttached(socket: ChoirSecondarySocket): boolean {
    return this.sockets.has(socket);
  }
}

/**
 * One Opus v3 packet to its PCM frame, as the main Mic's transport decodes
 * (audio-transport.ts): decoder state carries across packets, a hole is
 * concealed inside the decoder (OpusMicDecoder), and the encoder's look-ahead
 * is taken off the start.
 * Corrupt codec data is a hole, never stale decoder output.
 */
function decodeOpusFrame(
  opus: NonNullable<BoundSecondary['opus']>,
  packet: { generation: number; firstSampleIndex: number; sampleCount: number; pcm: Buffer; opusDelaySamples?: number },
): { generation: number; firstSampleIndex: number; pcm: Buffer } | null {
  if (packet.opusDelaySamples === undefined) return null;
  try {
    opus.decoder ??= new OpusMicDecoder();
    const pcm = opus.decoder.decodeAt(packet.firstSampleIndex, packet.pcm);
    if (pcm.byteLength !== packet.sampleCount * 2) throw new Error('Opus sample count mismatch');
    const start = packet.firstSampleIndex - packet.opusDelaySamples;
    const trim = Math.max(0, -start);
    if (trim * 2 >= pcm.byteLength) return null;
    return { generation: packet.generation, firstSampleIndex: Math.max(0, start), pcm: pcm.subarray(trim * 2) };
  } catch {
    opus.decoder = null;
    return null;
  }
}

