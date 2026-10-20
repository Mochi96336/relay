import { OpusMicDecoder, opusMicSampleSpan } from './opus-mic-decoder.js';
import { FRAME_MAGIC } from './pcm-frame.js';
import {
  AUDIO_PACKET_HEADER_BYTES, AUDIO_PACKET_VERSION, decodeAudioPacket,
} from './audio-packet.js';

/**
 * The second singer's media socket: B's packets in, checked PCM frames out
 * (onAcceptedFrame). It grants nothing itself: only a redeemed one-use claim
 * binds a socket (ChoirMediaClaims). No client JSON grants
 * media authority.
 *
 * Bound sockets are consumed even on malformed or stale input, so a second
 * Mic packet can never fall through to the main Mic or Robot path.
 *
 * A bound socket carries B's voice for as long as B's join allows it
 * (liveVoiceAllowed), song or no song.
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
  /** Server-generated identity of this socket. */
  transportId: string;
  sampleRate: number;
  generation: number | null;
  packetWindowStartMs: number;
  packetCount: number;
  /** v2 committed sequence identity, bounded to the recent reorder horizon. */
  latestSequence: number | null;
  seenSequences: Map<number, { start: number; end: number }>;
  /** Opus v3 sockets only: one decoder for this capture, including codec holes. */
  opus: { decoder: OpusMicDecoder | null } | null;
};

export type ChoirIngressResult =
  | { intercepted: false }
  | { intercepted: true; accepted: boolean; reason:
      'accepted' | 'malformed-frame' | 'too-large' | 'rate-limited'
      | 'stale-authority' | 'socket-identity-changed' | 'capture-restarted'
      | 'duplicate-packet' | 'sequence-out-of-window' | 'sample-overlap' | 'codec-error' };

export class ChoirIngress {
  private readonly sockets = new WeakMap<ChoirSecondarySocket, BoundSecondary>();
  /** One physical socket per server-issued transport identity at a time. */
  private readonly transportBindings = new Map<string, ChoirSecondarySocket>();
  private readonly maxFrameBytes: number;
  /** v2 replay/reorder horizon: no unbounded sequence maps. */
  private static readonly MAX_REORDER_SEQUENCES = 128;

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

  /** Every frame that passed the checks, for the room output to mix. */
  onAcceptedFrame: ((frame: { generation: number; firstSampleIndex: number; pcm: Buffer },
    sampleRate: number, participantId: string, nowMs: number) => void) | null = null;

  constructor(
    private readonly isSocketOpen: (socket: ChoirSecondarySocket) => boolean,
    /**
     * Whether B's join lets this participant be heard: B is the joined singer
     * and the singer B joined still holds the Mic.
     */
    private readonly liveVoiceAllowed: (participantId: string, nowMs: number) => boolean,
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
   * Binds B's media socket under a server-generated transport id, once its
   * claim is redeemed. The authenticated socket identity is checked again on
   * every frame. A main Mic, backing or monitor socket cannot double as it.
   */
  bind(
    socket: ChoirSecondarySocket,
    participantId: string,
    transportId: string,
    sourceRate: number,
    nowMs: number,
    packetVersion: 2 | 3 = 2,
  ): boolean {
    if (this.sockets.has(socket) || this.transportBindings.has(transportId)
      || !(packetVersion === 2 || (packetVersion === 3 && sourceRate === 48_000))
      || !this.isSocketOpen(socket)
      || socket.role !== 'unknown'
      || !participantId || socket.participantId !== participantId
      || !transportId || transportId !== transportId.trim()
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000
      || !Number.isFinite(nowMs) || nowMs < 0
      || !this.liveVoiceAllowed(participantId, nowMs)) return false;
    this.sockets.set(socket, {
      participantId, transportId, sampleRate: sourceRate, generation: null,
      packetWindowStartMs: nowMs, packetCount: 0,
      latestSequence: null, seenSequences: new Map(),
      opus: packetVersion === 3 ? { decoder: null } : null,
    });
    this.transportBindings.set(transportId, socket);
    return true;
  }

  /** The transport of B's open socket; null when B has none. */
  liveTransportFor(participantId: string): string | null {
    for (const [transportId, socket] of this.transportBindings) {
      if (this.sockets.get(socket)?.participantId === participantId && this.isSocketOpen(socket))
        return transportId;
    }
    return null;
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
    // Admission is a metadata transaction. Nothing that can reject a packet
    // may run after the stateful codec has consumed it.
    const { firstSampleIndex, sampleCount } = bound.opus ? opusMicSampleSpan(packet) : packet;
    if (!Number.isSafeInteger(firstSampleIndex) || firstSampleIndex < 0
      || sampleCount < 1 || sampleCount > Math.ceil(bound.sampleRate * this.maxPacketMs / 1_000)
      || !Number.isSafeInteger(firstSampleIndex + sampleCount))
      return rejected('malformed-frame');
    if (bound.generation !== null && packet.generation !== bound.generation)
      return rejected('capture-restarted');

    {
      const latest = bound.latestSequence;
      if (bound.seenSequences.has(sequence)) return rejected('duplicate-packet');
      if (latest !== null) {
        const forward = (sequence - latest) >>> 0;
        const backward = (latest - sequence) >>> 0;
        const horizon = ChoirIngress.MAX_REORDER_SEQUENCES;
        // Modular uint32 ordering: allow bounded retransmission/reorder and
        // ordinary wraparound, but not arbitrarily old/far-future claims.
        if (forward === 0) return rejected('duplicate-packet');
        if (forward < 0x8000_0000) {
          if (forward > 4 * horizon) return rejected('sequence-out-of-window');
        } else if (bound.opus || backward > horizon) {
          // B uses one ordered WebSocket, with no retransmission path. PCM
          // may fill retained history; Opus cannot rewind decoder history.
          return rejected('sequence-out-of-window');
        }
      }
      const start = firstSampleIndex;
      const end = start + sampleCount;
      for (const window of bound.seenSequences.values()) {
        if (start < window.end && end > window.start)
          return rejected('sample-overlap');
      }
    }
    if (!this.liveVoiceAllowed(bound.participantId, nowMs)) {
      this.releaseTransportBinding(socket, bound.transportId);
      return rejected('stale-authority');
    }
    bound.generation = packet.generation;
    {
      const latest = bound.latestSequence;
      if (latest === null || ((sequence - latest) >>> 0) < 0x8000_0000)
        bound.latestSequence = sequence;
      bound.seenSequences.set(sequence, {
        start: firstSampleIndex, end: firstSampleIndex + sampleCount,
      });
      const current = bound.latestSequence!;
      for (const previous of bound.seenSequences.keys()) {
        if (((current - previous) >>> 0)
          > ChoirIngress.MAX_REORDER_SEQUENCES)
          bound.seenSequences.delete(previous);
      }
    }
    const frame = bound.opus
      ? (bound.opus.decoder ??= new OpusMicDecoder()).decode(packet)
      : { generation: packet.generation, firstSampleIndex, pcm: packet.pcm };
    if (!frame) return rejected('codec-error');
    this.onAcceptedFrame?.(frame, bound.sampleRate, bound.participantId, nowMs);
    this.counts.accepted += 1;
    return { intercepted: true, accepted: true, reason: 'accepted' };
  }

  /** Retire a transport ownership claim without making its old socket PCM fall through. */
  private releaseTransportBinding(socket: ChoirSecondarySocket, transportId: string) {
    if (this.transportBindings.get(transportId) === socket)
      this.transportBindings.delete(transportId);
  }

  /** Lets go of sockets whose join ended while B was silent. */
  sweepStale(nowMs: number): number {
    let released = 0;
    for (const [transportId, socket] of this.transportBindings) {
      const bound = this.sockets.get(socket);
      if (!bound || !this.isSocketOpen(socket) || !this.liveVoiceAllowed(bound.participantId, nowMs)) {
        this.releaseTransportBinding(socket, transportId);
        released++;
      }
    }
    return released;
  }

  /** A physical close releases its own transport, never another Mic. Returns whether it was bound. */
  disconnect(socket: ChoirSecondarySocket): boolean {
    const bound = this.sockets.get(socket);
    if (!bound) return false;
    this.sockets.delete(socket);
    this.releaseTransportBinding(socket, bound.transportId);
    return true;
  }

  isAttached(socket: ChoirSecondarySocket): boolean {
    return this.sockets.has(socket);
  }
}
