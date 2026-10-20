import {
  AudioPacketReceiver,
  type AudioPacketReceiverOptions,
  type AudioPacketReceiverStats,
  type AudioPacketRetransmitRequest,
  type AudioPacketRetransmitStats,
} from './audio-packet-receiver.js';
import { decodePcmFrame, type PcmFrame } from './pcm-frame.js';
import { OpusMicDecoder, type OpusMicDecoderStats } from './opus-mic-decoder.js';
import type { AudioPacket } from './audio-packet.js';

export type AudioPacketVersion = 1 | 2;
export type AudioTransportStats = AudioPacketReceiverStats & { opus?: OpusMicDecoderStats };

export interface AudioTransport {
  readonly kind: 'websocket';
  readonly packetVersion: AudioPacketVersion;
  receive(buffer: Buffer, nowMs: number): PcmFrame[];
  flush(nowMs: number): PcmFrame[];
  stats(): AudioTransportStats | null;
  /** Sequenced transports only: see AudioPacketReceiver retransmission. */
  setRetransmitHoldAllowed?(allowed: boolean): void;
  setRetransmitRequestsEnabled?(enabled: boolean): void;
  pendingRetransmitRequests?(): AudioPacketRetransmitRequest[];
  retransmitRequestsSent?(requests: readonly AudioPacketRetransmitRequest[], nowMs: number): void;
  retransmitStats?(): AudioPacketRetransmitStats;
}

export type WebSocketAudioTransportOptions =
  | { packetVersion: 1 }
  | { packetVersion: 2; receiver: AudioPacketReceiverOptions };

class LegacyWebSocketAudioTransport implements AudioTransport {
  readonly kind = 'websocket' as const;
  readonly packetVersion = 1 as const;

  receive(buffer: Buffer, _nowMs: number): PcmFrame[] {
    return [decodePcmFrame(buffer)];
  }

  flush(_nowMs: number): PcmFrame[] {
    return [];
  }

  stats() {
    return null;
  }
}

class SequencedWebSocketAudioTransport implements AudioTransport {
  readonly kind = 'websocket' as const;
  readonly packetVersion = 2 as const;
  private readonly receiver: AudioPacketReceiver;
  private opusDecoder: OpusMicDecoder | null = null;

  constructor(options: AudioPacketReceiverOptions) {
    this.receiver = new AudioPacketReceiver(options);
  }

  receive(buffer: Buffer, nowMs: number): PcmFrame[] {
    return this.decodeOrdered(this.receiver.receive(buffer, nowMs));
  }

  flush(nowMs: number): PcmFrame[] {
    return this.decodeOrdered(this.receiver.flush(nowMs));
  }

  private decodeOrdered(packets: AudioPacket[]): PcmFrame[] {
    const output: PcmFrame[] = [];
    for (const packet of packets) {
      if (packet.opusDelaySamples === undefined) {
        this.opusDecoder = null;
        output.push(packet);
        continue;
      }
      this.opusDecoder ??= new OpusMicDecoder();
      const frame = this.opusDecoder.decode(packet);
      if (frame) output.push(frame);
    }
    return output;
  }

  stats() {
    return { ...this.receiver.stats(), ...(this.opusDecoder ? { opus: this.opusDecoder.stats() } : {}) };
  }

  setRetransmitHoldAllowed(allowed: boolean) {
    this.receiver.setRetransmitHoldAllowed(allowed);
  }

  setRetransmitRequestsEnabled(enabled: boolean) {
    this.receiver.setRetransmitRequestsEnabled(enabled);
  }

  pendingRetransmitRequests() {
    return this.receiver.pendingRetransmitRequests();
  }

  retransmitRequestsSent(requests: readonly AudioPacketRetransmitRequest[], nowMs: number) {
    this.receiver.retransmitRequestsSent(requests, nowMs);
  }

  retransmitStats() {
    return this.receiver.retransmitStats();
  }
}

/**
 * Current media adapter. The server feeds WebSocket binary messages into this
 * boundary; packet order/timeline semantics stay inside it. T2 can add another
 * adapter without teaching AudioSession about sockets or QUIC.
 */
export function createWebSocketAudioTransport(
  options: WebSocketAudioTransportOptions,
): AudioTransport {
  return options.packetVersion === 1
    ? new LegacyWebSocketAudioTransport()
    : new SequencedWebSocketAudioTransport(options.receiver);
}
