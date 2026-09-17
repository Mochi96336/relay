import WebSocket from 'ws';

import { createWebSocketAudioTransport, type AudioPacketVersion, type AudioTransport } from './audio-transport.js';
import type { AudioTransportConfig } from './audio-transport-config.js';
import type { AudioUplinkHealth } from './audio-uplink-health.js';
import type { PcmFrame } from './pcm-frame.js';
import type { RelaySocket } from './relay-socket-server.js';

export const DEFAULT_UPLINK_HEALTH_TIMEOUT_MS = 4_000;

export type MicRuntimeOptions = {
  audioTransportConfig: AudioTransportConfig;
  firstFrameTimeoutMs: number;
  streamLiveMs: number;
  uplinkHealthTimeoutMs?: number;
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
  /** An established media capture was replaced rather than continued. */
  captureReplaced: boolean;
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
  private readonly uplinkHealthTimeoutMs: number;
  private currentPublisher: RelaySocket | null = null;
  private currentSampleRate: number | null = null;
  private currentAudioTransport: AudioTransport | null = null;
  private currentMediaTicket: string | null = null;
  private currentMediaOwnerId: string | null = null;
  private currentMediaGeneration: number | null = null;
  private currentUplinkHealth: AudioUplinkHealth | null = null;
  private currentUplinkHealthAt = -Infinity;
  private uplinkHealthDeadline: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = -Infinity;
  private lastFrameOwnerId: string | null = null;
  private lastFrameGeneration: number | null = null;
  /**
   * Monotonic accepted-PCM evidence for the current capture generation.
   *
   * This advances only through noteFrame(), whose server caller is downstream
   * of AudioSession.ingestMic(...).samples.length > 0. It therefore proves
   * application-level PCM intake rather than socket/datagram/write activity.
   */
  private currentAcceptedFrameSerial = 0;
  private firstFrameWaitStartedAt = -Infinity;

  constructor(options: MicRuntimeOptions) {
    this.options = options;
    const uplinkHealthTimeoutMs = options.uplinkHealthTimeoutMs ?? DEFAULT_UPLINK_HEALTH_TIMEOUT_MS;
    if (!Number.isFinite(uplinkHealthTimeoutMs) || uplinkHealthTimeoutMs <= 0) {
      throw new Error('MicRuntime uplinkHealthTimeoutMs must be positive.');
    }
    this.uplinkHealthTimeoutMs = uplinkHealthTimeoutMs;
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

  get acceptedFrameSerial() {
    return this.currentAcceptedFrameSerial;
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
    const hadMediaCapture = this.currentAudioTransport !== null;
    // Media authority deliberately survives a short control-socket grace. Treat
    // a same-participant reconnect as a replacement even after the old control
    // pointer has detached, otherwise a changed capture can bypass the server's
    // timing-invalidation boundary merely by disconnecting first.
    const sameParticipantMedia = Boolean(
      socket.participantId
      && this.currentMediaOwnerId === socket.participantId
      && this.currentAudioTransport,
    );
    // A capture generation names one capture clock, not just a packet epoch.
    // Reusing it with a different sample rate is contradictory identity and
    // must not inherit receiver sequence state, media tickets, or calibration.
    const continuingV2Capture = Boolean(
      sameParticipantMedia
      && captureGeneration !== null
      && this.currentMediaGeneration === captureGeneration
      && this.currentSampleRate === sampleRate
      && audioPacketVersion === 2
      && this.currentAudioTransport?.packetVersion === 2,
    );
    const sameParticipantReplacement = Boolean(
      sameParticipantMedia
      && (previousPublisher !== socket || !continuingV2Capture),
    );
    const sameCapture = Boolean(sameParticipantReplacement && continuingV2Capture);
    const preservedAudioTransport = continuingV2Capture;
    // This is deliberately independent of the control-socket pointer and
    // participant identity. A cross-owner takeover, a reconnect after control
    // grace, and a contradictory same-generation/sample-rate registration all
    // replace the acoustic capture if an old media transport existed and was
    // not explicitly preserved.
    const captureReplaced = hadMediaCapture && !preservedAudioTransport;

    socket.sampleRate = sampleRate;
    socket.captureGeneration = captureGeneration ?? undefined;
    socket.audioPacketVersion = audioPacketVersion;
    this.currentPublisher = socket;
    this.currentSampleRate = sampleRate;
    this.armUplinkHealthDeadline(socket, captureGeneration, audioPacketVersion);

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
      captureReplaced,
      preservedAudioTransport,
    };
  }

  detachPublisher(socket: RelaySocket) {
    if (this.currentPublisher !== socket) return false;
    this.currentPublisher = null;
    this.clearUplinkHealthDeadline();
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
    this.clearUplinkHealthDeadline();
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
    this.armUplinkHealthDeadline(socket, health.captureGeneration, 2);
    if (socket.readyState === WebSocket.OPEN && typeof socket.send === 'function') {
      try {
        socket.send(JSON.stringify({
          type: 'audio-uplink-health-ack',
          version: 1,
          captureGeneration: health.captureGeneration,
          ...(health.healthRequestId === undefined ? {} : { healthRequestId: health.healthRequestId }),
          pcm: {
            acceptedFrameSerial: this.currentAcceptedFrameSerial,
            receivedPacketSerial: this.currentAudioTransport?.stats()?.emittedPackets ?? 0,
            mediaPath: this.mediaPath(),
          },
        }));
      } catch {}
    }
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

  freshUplinkHealthPayload(nowMs: number) {
    const payload = this.uplinkHealthPayload(nowMs);
    if (
      !payload
      || payload.reportAgeMs === null
      || payload.reportAgeMs > this.uplinkHealthTimeoutMs
    ) return null;
    return payload;
  }

  private clearUplinkHealthDeadline() {
    if (this.uplinkHealthDeadline !== null) clearTimeout(this.uplinkHealthDeadline);
    this.uplinkHealthDeadline = null;
  }

  private armUplinkHealthDeadline(
    socket: RelaySocket,
    captureGeneration: number | null,
    audioPacketVersion: AudioPacketVersion,
  ) {
    this.clearUplinkHealthDeadline();
    if (audioPacketVersion !== 2 || captureGeneration === null) return;

    const timer = setTimeout(() => {
      if (this.uplinkHealthDeadline !== timer) return;
      this.uplinkHealthDeadline = null;
      if (
        this.currentPublisher !== socket
        || socket.role !== 'publisher'
        || socket.audioPacketVersion !== 2
        || socket.captureGeneration !== captureGeneration
      ) return;
      try {
        socket.close(4000, 'publisher uplink health stale');
      } catch {
        try {
          socket.terminate();
        } catch {}
      }
    }, this.uplinkHealthTimeoutMs);
    timer.unref?.();
    this.uplinkHealthDeadline = timer;
  }

  resetFlowEvidence(nowMs: number) {
    this.lastFrameAt = -Infinity;
    this.lastFrameOwnerId = this.currentMediaOwnerId;
    this.lastFrameGeneration = this.currentMediaGeneration;
    this.currentAcceptedFrameSerial = 0;
    this.firstFrameWaitStartedAt = this.currentMediaOwnerId === null ? -Infinity : nowMs;
  }

  noteFrame(nowMs: number) {
    this.lastFrameAt = nowMs;
    this.lastFrameOwnerId = this.currentMediaOwnerId;
    this.lastFrameGeneration = this.currentMediaGeneration;
    if (this.currentAcceptedFrameSerial < Number.MAX_SAFE_INTEGER) {
      this.currentAcceptedFrameSerial += 1;
    }
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
