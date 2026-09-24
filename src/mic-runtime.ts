import WebSocket from 'ws';

import { createWebSocketAudioTransport, type AudioPacketVersion, type AudioTransport } from './audio-transport.js';
import type { AudioTransportConfig } from './audio-transport-config.js';
import type { AudioUplinkHealth } from './audio-uplink-health.js';
import type { PcmFrame } from './pcm-frame.js';
import type { RelaySocket } from './relay-socket-server.js';
import {
  MAX_RETRANSMIT_REQUEST_SEQUENCES,
  encodeRetransmitRequest,
} from '../shared/retransmit-request.js';

/**
 * Mix headroom below which a lost packet stops waiting for its repeat. It
 * covers one 20 ms mix frame, the 5 ms mixer tick and limiter look-ahead,
 * with room for arrival jitter on the packets queued behind the hole.
 */
const RETRANSMIT_MIN_MIX_HEADROOM_MS = 60;

export const DEFAULT_UPLINK_HEALTH_TIMEOUT_MS = 4_000;

export type MicRuntimeOptions = {
  audioTransportConfig: AudioTransportConfig;
  firstFrameTimeoutMs: number;
  streamLiveMs: number;
  uplinkHealthTimeoutMs?: number;
  createDirectMediaTicket?: () => string | null;
  directMediaConnected?: (ticket: string | null) => boolean;
  /** Best-effort datagram to the page over its direct media session. */
  sendDirectMedia?: (ticket: string | null, bytes: Uint8Array) => boolean;
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
   * Source-sample cursor reported by the browser at the most recent muted ->
   * unmuted transition. Control health and media can travel on different paths,
   * so frames at or before this cursor are allowed to arrive but cannot prove
   * post-unmute live flow.
   */
  private postUnmuteSampleBarrier: number | null = null;
  /**
   * Source cursor reported when a sustained worklet input gap recovers.
   * Padded zero PCM before this boundary is valid timeline intake but cannot
   * prove that real microphone input has returned.
   */
  private postInputGapSampleBarrier: number | null = null;
  private latestAcceptedFrameEndSample: number | null = null;
  /** Highest browser capture cursor accepted for the current capture clock. */
  private latestUplinkHealthCapturedSamples: number | null = null;
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

  /**
   * Retransmission for lost Mic packets, one tick at a time.
   *
   * A page advertises that it keeps recently sent packets through its uplink
   * health; only then may a hole hold the ordered stream waiting for a repeat.
   * The mix headroom decides how long that wait may last: while enough audio
   * stands between the hole and the read head, waiting costs nothing audible;
   * once it runs short the hole is released as ordinary loss. A page that
   * never answers therefore costs at most the headroom it was already given.
   */
  serviceRetransmits(nowMs: number, mixHeadroomMs: number | null) {
    const transport = this.currentAudioTransport;
    if (!transport?.takeRetransmitRequests) return 0;
    const health = this.freshUplinkHealthPayload(nowMs);
    const capable = (health?.transport.retransmitBufferPackets ?? 0) > 0;
    const generation = this.currentMediaGeneration;
    const ticket = this.currentMediaTicket;
    // Either path can carry a request. The direct session keeps working while
    // the control socket is inside its reconnect grace, and vice versa. With
    // neither, nothing may be requested or held for: a hole that cannot be
    // repeated is ordinary loss.
    const directPath = Boolean(
      this.options.sendDirectMedia
      && ticket
      && this.options.directMediaConnected?.(ticket),
    );
    const socket = this.currentPublisher;
    const controlPath = Boolean(socket && socket.readyState === WebSocket.OPEN);
    const requestable = capable && generation !== null && (directPath || controlPath);
    transport.setRetransmitRequestsEnabled?.(requestable);
    transport.setRetransmitHoldAllowed?.(
      requestable
      && mixHeadroomMs !== null
      && mixHeadroomMs > RETRANSMIT_MIN_MIX_HEADROOM_MS,
    );

    const requests = transport.takeRetransmitRequests();
    if (!requestable || requests.length === 0 || generation === null) return 0;

    let sent = false;
    // The direct datagram path is the fast one: the repeat comes back on it.
    // The control socket carries the same request because datagrams are
    // unreliable; the page answers each sequence once, whichever lands first.
    if (directPath && ticket) {
      for (let offset = 0; offset < requests.length; offset += MAX_RETRANSMIT_REQUEST_SEQUENCES) {
        sent = this.options.sendDirectMedia!(
          ticket,
          encodeRetransmitRequest(
            generation,
            requests.slice(offset, offset + MAX_RETRANSMIT_REQUEST_SEQUENCES),
          ),
        ) || sent;
      }
    }
    if (controlPath && socket) {
      try {
        socket.send(JSON.stringify({
          type: 'audio-retransmit-request',
          version: 1,
          captureGeneration: generation,
          sequences: requests,
        }));
        sent = true;
      } catch {}
    }
    return sent ? requests.length : 0;
  }

  retransmitStats() {
    return this.currentAudioTransport?.retransmitStats?.() ?? null;
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
    if (
      this.latestUplinkHealthCapturedSamples !== null
      && health.capturedSamples < this.latestUplinkHealthCapturedSamples
    ) return false;

    const wasMuted = this.currentUplinkHealth?.inputMuted === true;
    if (wasMuted && health.inputMuted !== true) {
      const barrier = health.capturedSamples;
      // WebTransport media may beat the control WebSocket health message to
      // Relay. A frame already accepted beyond the browser's unmute cursor is
      // valid post-unmute evidence; otherwise retain the cursor as a barrier
      // for late muted-period frames arriving after control.
      this.postUnmuteSampleBarrier = this.latestAcceptedFrameEndSample !== null
        && this.latestAcceptedFrameEndSample > barrier
        ? null
        : barrier;
    }
    const wasInputGapActive = this.currentUplinkHealth?.inputGapActive === true;
    if (wasInputGapActive && health.inputGapActive !== true) {
      const barrier = health.capturedSamples;
      // The worklet reports recovery before subsequent real input is packetized.
      // Media may then beat this control health over WebTransport, so accept an
      // already-arrived frame only when it extends beyond the recovery cursor.
      this.postInputGapSampleBarrier = this.latestAcceptedFrameEndSample !== null
        && this.latestAcceptedFrameEndSample > barrier
        ? null
        : barrier;
    }
    this.latestUplinkHealthCapturedSamples = health.capturedSamples;
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
            receivedSampleSerial: this.currentAudioTransport?.stats()?.emittedSamples ?? 0,
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
    this.postUnmuteSampleBarrier = null;
    this.postInputGapSampleBarrier = null;
    this.latestAcceptedFrameEndSample = null;
    this.latestUplinkHealthCapturedSamples = null;
    this.firstFrameWaitStartedAt = this.currentMediaOwnerId === null ? -Infinity : nowMs;
  }

  noteFrame(nowMs: number, frame: PcmFrame | null = null) {
    // acceptedFrameSerial remains transport/application intake evidence even
    // when the accepted frame belongs to the muted side of an unmute barrier.
    if (this.currentAcceptedFrameSerial < Number.MAX_SAFE_INTEGER) {
      this.currentAcceptedFrameSerial += 1;
    }

    const firstSampleIndex = frame?.firstSampleIndex;
    const sourceSampleCount = frame ? Math.floor(frame.pcm.byteLength / 2) : 0;
    const frameEnd = firstSampleIndex === null || firstSampleIndex === undefined
      ? null
      : firstSampleIndex + sourceSampleCount;
    if (frameEnd !== null && Number.isFinite(frameEnd)) {
      this.latestAcceptedFrameEndSample = this.latestAcceptedFrameEndSample === null
        ? frameEnd
        : Math.max(this.latestAcceptedFrameEndSample, frameEnd);
    }

    const unmuteBarrier = this.postUnmuteSampleBarrier;
    const inputGapBarrier = this.postInputGapSampleBarrier;
    const blockedByUnmute = unmuteBarrier !== null
      && (frameEnd === null || !Number.isFinite(frameEnd) || frameEnd <= unmuteBarrier);
    const blockedByInputGap = inputGapBarrier !== null
      && (frameEnd === null || !Number.isFinite(frameEnd) || frameEnd <= inputGapBarrier);

    // A frame that clears one source-recovery boundary should retire that
    // boundary even if another, later boundary still keeps the source closed.
    if (unmuteBarrier !== null && !blockedByUnmute) this.postUnmuteSampleBarrier = null;
    if (inputGapBarrier !== null && !blockedByInputGap) this.postInputGapSampleBarrier = null;
    if (blockedByUnmute || blockedByInputGap) return;

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
      // AudioPacket v2 makes browser source-state health mandatory from
      // registration onward. Direct media may bridge control reconnects only
      // while that last source-state report is still authoritative. Legacy v1
      // never carried this health contract and retains its PCM-only behavior.
      && (
        this.currentAudioTransport?.packetVersion !== 2
        || (
          this.freshUplinkHealthPayload(nowMs) !== null
          && this.currentUplinkHealth?.inputMutedObserved !== false
          && this.currentUplinkHealth?.inputGapActiveObserved !== false
        )
      )
      && this.currentUplinkHealth?.inputMuted !== true
      && this.currentUplinkHealth?.inputGapActive !== true
      && this.postUnmuteSampleBarrier === null
      && this.postInputGapSampleBarrier === null
      && nowMs - this.lastFrameAt < this.options.streamLiveMs;
  }

  directMediaOffer() {
    return this.currentMediaTicket && this.options.offerDirectMedia
      ? this.options.offerDirectMedia(this.currentMediaTicket)
      : undefined;
  }
}
