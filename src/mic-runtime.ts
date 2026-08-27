import WebSocket from 'ws';

import { createWebSocketAudioTransport, type AudioPacketVersion, type AudioTransport } from './audio-transport.js';
import type { AudioTransportConfig } from './audio-transport-config.js';
import type { AudioUplinkHealth } from './audio-uplink-health.js';
import type { PcmFrame } from './pcm-frame.js';
import type { RelaySocket } from './relay-socket-server.js';

export type MicRuntimeOptions = {
  audioTransportConfig: AudioTransportConfig;
  firstFrameTimeoutMs: number;
  streamLiveMs: number;
  createDirectMediaTicket?: () => string | null;
  directMediaConnected?: (ticket: string | null) => boolean;
  offerDirectMedia?: (ticket: string) => unknown;
};

export type MicPublisherRegistration = {
  socket: RelaySocket;
  sampleRate: number;
  captureGeneration: number | null;
  initialSequence?: number;
  audioPacketVersion: AudioPacketVersion;
  nowMs: number;
};

export type MicPublisherBindResult = {
  previousPublisher: RelaySocket | null;
  sameParticipantReplacement: boolean;
  sameCapture: boolean;
  preservedAudioTransport: boolean;
};

/**
 * Owns live Microphone transport state after participant authority has already
 * admitted a publisher registration.
 *
 * This class deliberately does not acquire/release the Mic lease, invalidate
 * timing, publish product state, or write AudioSession. Those remain orchestration
 * concerns. It owns only the control/media transport identity and evidence that
 * describes whether that admitted transport is currently carrying audio.
 */
export class MicRuntime {
  private readonly options: MicRuntimeOptions;
  private currentPublisher: RelaySocket | null = null;
  private currentSampleRate: number | null = null;
  private currentAudioTransport: AudioTransport | null = null;
  private currentMediaTicket: string | null = null;
  private currentMediaOwnerId: string | null = null;
  private currentMediaGeneration: number | null = null;
  private currentUplinkHealth: AudioUplinkHealth | null = null;
  private currentUplinkHealthAt = -Infinity;
  private lastFrameAt = -Infinity;
  private lastFrameOwnerId: string | null = null;
  private lastFrameGeneration: number | null = null;
  private firstFrameWaitStartedAt = -Infinity;

  constructor(options: MicRuntimeOptions) {
    this.options = options;
  }

  get publisher() {
    return this.currentPublisher;
  }

  get sampleRate() {
    return this.currentSampleRate;
  }

  get audioTransport() {
    return this.currentAudioTransport;
  }

  get mediaTicket() {
    return this.currentMediaTicket;
  }

  get mediaOwnerId() {
    return this.currentMediaOwnerId;
  }

  get mediaGeneration() {
    return this.currentMediaGeneration;
  }

  isPublisher(socket: RelaySocket) {
    return socket === this.currentPublisher && socket.role === 'publisher';
  }

  controlConnected() {
    return this.currentPublisher?.readyState === WebSocket.OPEN;
  }

  directMediaConnected() {
    return this.options.directMediaConnected?.(this.currentMediaTicket) ?? false;
  }

  connected() {
    return this.controlConnected() || this.directMediaConnected();
  }

  mediaPath(): 'websocket' | 'webtransport' | null {
    if (this.directMediaConnected()) return 'webtransport';
    if (this.controlConnected()) return 'websocket';
    return null;
  }

  bindPublisher(registration: MicPublisherRegistration): MicPublisherBindResult {
    const {
      socket,
      sampleRate,
      captureGeneration,
      initialSequence,
      audioPacketVersion,
      nowMs,
    } = registration;
    if (audioPacketVersion === 2 && captureGeneration === null) {
      throw new Error('AudioPacket v2 requires a capture generation.');
    }

    const previousPublisher = this.currentPublisher;
    const sameParticipantReplacement = Boolean(
      previousPublisher
      && previousPublisher !== socket
      && previousPublisher.participantId
      && previousPublisher.participantId === socket.participantId,
    );
    const sameCapture = Boolean(
      sameParticipantReplacement
      && previousPublisher?.captureGeneration !== undefined
      && captureGeneration !== null
      && previousPublisher.captureGeneration === captureGeneration,
    );
    const reconnectingSameCapture = Boolean(
      socket.participantId
      && this.currentMediaOwnerId === socket.participantId
      && captureGeneration !== null
      && this.currentMediaGeneration === captureGeneration
      && audioPacketVersion === 2
      && this.currentAudioTransport?.packetVersion === 2,
    );
    const preservedAudioTransport = Boolean(
      reconnectingSameCapture
      || (
        sameCapture
        && previousPublisher?.audioPacketVersion === 2
        && audioPacketVersion === 2
        && this.currentAudioTransport
      ),
    );

    socket.sampleRate = sampleRate;
    socket.captureGeneration = captureGeneration ?? undefined;
    socket.audioPacketVersion = audioPacketVersion;
    this.currentPublisher = socket;
    this.currentSampleRate = sampleRate;

    if (!preservedAudioTransport) {
      this.currentUplinkHealth = null;
      this.currentUplinkHealthAt = -Infinity;
      if (audioPacketVersion === 2) {
        this.currentAudioTransport = createWebSocketAudioTransport({
          packetVersion: 2,
          receiver: {
            source: 'mic',
            generation: captureGeneration!,
            initialSequence,
            ...this.options.audioTransportConfig,
          },
        });
        this.currentMediaGeneration = captureGeneration;
        this.currentMediaOwnerId = socket.participantId ?? null;
        this.currentMediaTicket = this.options.createDirectMediaTicket?.() ?? null;
      } else {
        this.currentAudioTransport = createWebSocketAudioTransport({ packetVersion: 1 });
        this.currentMediaGeneration = null;
        this.currentMediaOwnerId = socket.participantId ?? null;
        this.currentMediaTicket = null;
      }
      this.resetFlowEvidence(nowMs);
    }

    return {
      previousPublisher,
      sameParticipantReplacement,
      sameCapture,
      preservedAudioTransport,
    };
  }

  detachPublisher(socket: RelaySocket) {
    if (this.currentPublisher !== socket) return false;
    this.currentPublisher = null;
    return true;
  }

  clearMediaAuthority(nowMs = 0) {
    this.currentAudioTransport = null;
    this.currentMediaTicket = null;
    this.currentMediaOwnerId = null;
    this.currentMediaGeneration = null;
    this.currentUplinkHealth = null;
    this.currentUplinkHealthAt = -Infinity;
    this.currentSampleRate = null;
    this.resetFlowEvidence(nowMs);
  }

  receivePublisher(socket: RelaySocket, buffer: Buffer, nowMs: number): PcmFrame[] {
    if (!this.isPublisher(socket) || !this.currentAudioTransport) return [];
    return this.currentAudioTransport.receive(buffer, nowMs);
  }

  authorizeDirectMedia(ticket: string | null) {
    return Boolean(
      ticket
      && ticket === this.currentMediaTicket
      && this.currentAudioTransport?.packetVersion === 2,
    );
  }

  receiveDirectMedia(ticket: string | null, packet: Buffer, nowMs: number): PcmFrame[] {
    if (!this.authorizeDirectMedia(ticket) || !this.currentAudioTransport) return [];
    return this.currentAudioTransport.receive(packet, nowMs);
  }

  flush(nowMs: number): PcmFrame[] {
    return this.currentAudioTransport?.flush(nowMs) ?? [];
  }

  receiverStats() {
    return this.currentAudioTransport?.stats() ?? null;
  }

  noteUplinkHealth(socket: RelaySocket, health: AudioUplinkHealth, nowMs: number) {
    if (
      !this.isPublisher(socket)
      || socket.audioPacketVersion !== 2
      || socket.captureGeneration === undefined
      || health.captureGeneration !== socket.captureGeneration
    ) return false;
    this.currentUplinkHealth = health;
    this.currentUplinkHealthAt = nowMs;
    return true;
  }

  uplinkHealthPayload(nowMs: number) {
    if (!this.currentUplinkHealth) return null;
    return {
      ...this.currentUplinkHealth,
      reportAgeMs: Number.isFinite(this.currentUplinkHealthAt)
        ? Math.max(0, Math.round(nowMs - this.currentUplinkHealthAt))
        : null,
    };
  }

  resetFlowEvidence(nowMs: number) {
    this.lastFrameAt = -Infinity;
    this.lastFrameOwnerId = this.currentMediaOwnerId;
    this.lastFrameGeneration = this.currentMediaGeneration;
    this.firstFrameWaitStartedAt = this.currentMediaOwnerId === null ? -Infinity : nowMs;
  }

  noteFrame(nowMs: number) {
    this.lastFrameAt = nowMs;
    this.lastFrameOwnerId = this.currentMediaOwnerId;
    this.lastFrameGeneration = this.currentMediaGeneration;
  }

  flowObserved() {
    return Number.isFinite(this.lastFrameAt)
      && this.lastFrameOwnerId === this.currentMediaOwnerId
      && this.lastFrameGeneration === this.currentMediaGeneration;
  }

  frameAgeMs(nowMs: number) {
    return this.flowObserved() ? Math.round(nowMs - this.lastFrameAt) : null;
  }

  startupTimedOut(nowMs: number) {
    return this.connected()
      && !this.flowObserved()
      && Number.isFinite(this.firstFrameWaitStartedAt)
      && nowMs - this.firstFrameWaitStartedAt >= this.options.firstFrameTimeoutMs;
  }

  streaming(nowMs: number) {
    return this.connected()
      && this.flowObserved()
      && this.currentUplinkHealth?.inputMuted !== true
      && nowMs - this.lastFrameAt < this.options.streamLiveMs;
  }

  directMediaOffer() {
    return this.currentMediaTicket && this.options.offerDirectMedia
      ? this.options.offerDirectMedia(this.currentMediaTicket)
      : undefined;
  }
}
