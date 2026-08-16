import {
  AudioPacketReceiver,
  type AudioPacketReceiverOptions,
  type AudioPacketReceiverStats,
} from './audio-packet-receiver.js';
import { decodePcmFrame, type PcmFrame } from './pcm-frame.js';

export type AudioPacketVersion = 1 | 2;

export interface AudioTransport {
  readonly kind: 'websocket';
  readonly packetVersion: AudioPacketVersion;
  receive(buffer: Buffer, nowMs: number): PcmFrame[];
  flush(nowMs: number): PcmFrame[];
  stats(): AudioPacketReceiverStats | null;
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

  constructor(options: AudioPacketReceiverOptions) {
    this.receiver = new AudioPacketReceiver(options);
  }

  receive(buffer: Buffer, nowMs: number): PcmFrame[] {
    return this.receiver.receive(buffer, nowMs);
  }

  flush(nowMs: number): PcmFrame[] {
    return this.receiver.flush(nowMs);
  }

  stats() {
    return this.receiver.stats();
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
