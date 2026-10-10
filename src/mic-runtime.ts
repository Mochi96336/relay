import WebSocket from 'ws';

import { createWebSocketAudioTransport, type AudioPacketVersion, type AudioTransport } from './audio-transport.js';
import type { AudioTransportConfig } from './audio-transport-config.js';
import type { AudioUplinkHealth } from './audio-uplink-health.js';
import type { PcmFrame } from './pcm-frame.js';
import type { RelaySocket } from './relay-socket-server.js';
import {
  MAX_RETRANSMIT_REQUEST_SEQUENCES,
  encodeRetransmitRequest,
  MAX_RETRANSMIT_REQUEST_ATTEMPT,
} from '../shared/retransmit-request.js';

/**
 * Mix headroom below which a lost packet stops waiting for its repeat. It
 * covers one 20 ms mix frame, the 5 ms mixer tick and limiter look-ahead,
 * with room for arrival jitter on the packets queued behind the hole.
 */
const RETRANSMIT_MIN_MIX_HEADROOM_MS = 60;
/**
 * How long a request path may be missing before holes stop being requested.
 * Both paths blink during a Wi-Fi roam or a socket reconnect; a hole noticed
 * in that blink is still worth asking for once a path is back, and the hold
 * stays bounded by the mix headroom either way.
 */
const RETRANSMIT_PATH_GRACE_MS = 500;

export const DEFAULT_UPLINK_HEALTH_TIMEOUT_MS = 4_000;
/**
 * A v2 publisher control socket is closed only once nothing at all has arrived
 * on it for this long. Health that is merely late is not a dead socket: on
 * 2026-10-09 a congested uplink delayed health past 4 s, the socket was closed
 * as stale, and the reconnect over the same congested path dropped audio. Ten
 * reconnects in 2.5 minutes cost 37 s of voice.
 */
export const DEFAULT_PUBLISHER_CONTROL_SILENCE_MS = 10_000;
/** A socket that keeps talking but never sends health Relay accepts is closed after this. */
export const DEFAULT_PUBLISHER_HEALTH_GIVE_UP_MS = 30_000;

export type MicRuntimeOptions = {
  audioTransportConfig: AudioTransportConfig;
  firstFrameTimeoutMs: number;
  streamLiveMs: number;
  uplinkHealthTimeoutMs?: number;
  /** Never shorter than uplinkHealthTimeoutMs. */
  publisherControlSilenceMs?: number;
  /** Never shorter than publisherControlSilenceMs. */
  publisherHealthGiveUpMs?: number;
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
  private readonly publisherControlSilenceMs: number;
  private readonly publisherHealthGiveUpMs: number;
  /** When anything last arrived on the current publisher socket. */
  private publisherInboundAt = -Infinity;
  /** When the current publisher socket was bound or last sent health Relay accepted. */
  private publisherHealthAt = -Infinity;
  private currentPublisher: RelaySocket | null = null;
  private currentSampleRate: number | null = null;
  private currentAudioTransport: AudioTransport | null = null;
  private currentMediaTicket: string | null = null;
  /** When a retransmit request path was last available, for the current transport. */
  private retransmitPathSeen: { transport: AudioTransport; atMs: number } | null = null;
  private currentMediaOwnerId: string | null = null;
  private currentMediaGeneration: number | null = null;
  private currentUplinkHealth: AudioUplinkHealth | null = null;
  private currentUplinkHealthAt = -Infinity;
  private uplinkHealthDeadline: ReturnType<typeof setTimeout> | null = null;
  /** The path the current transport's latest Mic packet arrived on. */
  private lastMediaArrival: { path: 'websocket' | 'webtransport'; atMs: number } | null = null;
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
    this.publisherControlSilenceMs = Math.max(
      uplinkHealthTimeoutMs,
      options.publisherControlSilenceMs ?? DEFAULT_PUBLISHER_CONTROL_SILENCE_MS,
    );
    this.publisherHealthGiveUpMs = Math.max(
      this.publisherControlSilenceMs,
      options.publisherHealthGiveUpMs ?? DEFAULT_PUBLISHER_HEALTH_GIVE_UP_MS,
    );
  }

  /** Something arrived on `socket`: if it is the publisher's, it is not silent. */
  noteInbound(socket: RelaySocket, nowMs = performance.now()) {
    if (socket === this.currentPublisher) this.publisherInboundAt = Math.max(this.publisherInboundAt, nowMs);
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

  /**
   * The path Mic audio is actually arriving on: that of the latest packet,
   * while packets are fresh, and otherwise the connected path (mediaPath).
   *
   * mediaPath says which sessions are up. It is no account of the audio: on
   * 2026-10-09 an iPhone opened a WebTransport session, failed to finish
   * setting it up, and sent everything over WebSocket, while status and
   * Technical details said the Mic was on WebTransport. The health ACK carries
   * this path too: after demoting WebTransport, the phone starts proving the
   * WebSocket path only once the ACK says Relay is receiving on it, which a
   * WebTransport session still open on Relay's side would hold off.
   */
  mediaArrivalPath(nowMs: number): 'websocket' | 'webtransport' | null {
    const arrival = this.lastMediaArrival;
    if (arrival && nowMs - arrival.atMs <= this.options.streamLiveMs) return arrival.path;
    return this.mediaPath();
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
    // A new physical socket has said nothing yet: its silence starts now.
    this.publisherInboundAt = -Infinity;
    this.publisherHealthAt = -Infinity;
    this.armUplinkHealthDeadline(socket, captureGeneration, audioPacketVersion);

    if (!preservedAudioTransport) {
      this.lastMediaArrival = null;
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
    this.lastMediaArrival = null;
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
    this.lastMediaArrival = { path: 'websocket', atMs: nowMs };
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
    this.lastMediaArrival = { path: 'webtransport', atMs: nowMs };
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
    if (!transport?.pendingRetransmitRequests || !transport.retransmitRequestsSent) return 0;
    // Whether the page keeps a history is a fact about the page, not about how
    // recently it reported: health rides the control socket, and a stalled TCP
    // link delays it exactly when datagrams are losing packets. The last report
    // of this capture decides; a replaced capture clears it.
    const capable = (this.currentUplinkHealth?.transport.retransmitBufferPackets ?? 0) > 0;
    const generation = this.currentMediaGeneration;
    const ticket = this.currentMediaTicket;
    // Either path can carry a request. The direct session keeps working while
    // the control socket is inside its reconnect grace, and vice versa. A
    // brief loss of both only delays requests: they stay queued and holes are
    // still recorded. Longer, and a hole that cannot be repeated is ordinary
    // loss, neither requested nor held for.
    const directPath = Boolean(
      this.options.sendDirectMedia
      && ticket
      && this.options.directMediaConnected?.(ticket),
    );
    const socket = this.currentPublisher;
    const controlPath = Boolean(socket && socket.readyState === WebSocket.OPEN);
    const pathUp = directPath || controlPath;
    if (this.retransmitPathSeen?.transport !== transport) this.retransmitPathSeen = null;
    if (pathUp) this.retransmitPathSeen = { transport, atMs: nowMs };
    const pathRecent = this.retransmitPathSeen !== null
      && nowMs - this.retransmitPathSeen.atMs <= RETRANSMIT_PATH_GRACE_MS;
    const requestable = capable && generation !== null && pathRecent;
    transport.setRetransmitRequestsEnabled?.(requestable);
    // Holding for a late packet needs no path and no page history: only mix
    // headroom. A page that cannot repeat still has packets that are merely late.
    transport.setRetransmitHoldAllowed?.(
      mixHeadroomMs !== null && mixHeadroomMs > RETRANSMIT_MIN_MIX_HEADROOM_MS,
    );

    // Requests stay queued in the receiver until one actually leaves: with no
    // path this tick, they wait for the next one instead of being dropped.
    if (!requestable || !pathUp || generation === null) return 0;
    const requests = transport.pendingRetransmitRequests();
    if (requests.length === 0) return 0;

    const byAttempt = new Map<number, number[]>();
    for (const { sequence, attempt } of requests) {
      const sequences = byAttempt.get(attempt) ?? [];
      sequences.push(sequence);
      byAttempt.set(attempt, sequences);
    }

    // Track delivery per sequence: one batch that went out must not mark
    // another whose send failed as asked for. Those stay queued.
    const delivered = new Set<number>();
    for (const [attempt, sequences] of byAttempt) {
      // The direct datagram path is the fast one: the repeat comes back on it.
      // The control socket carries the same request because datagrams are
      // unreliable; the page answers each attempt once, whichever lands first.
      if (directPath && ticket) {
        for (let offset = 0; offset < sequences.length; offset += MAX_RETRANSMIT_REQUEST_SEQUENCES) {
          const batch = sequences.slice(offset, offset + MAX_RETRANSMIT_REQUEST_SEQUENCES);
          if (this.options.sendDirectMedia!(
            ticket,
            encodeRetransmitRequest(generation, batch, Math.min(attempt, MAX_RETRANSMIT_REQUEST_ATTEMPT)),
          )) {
            for (const sequence of batch) delivered.add(sequence);
          }
        }
      }
      if (controlPath && socket) {
        try {
          socket.send(JSON.stringify({
            type: 'audio-retransmit-request',
            version: 1,
            captureGeneration: generation,
            attempt,
            sequences,
          }));
          for (const sequence of sequences) delivered.add(sequence);
        } catch {}
      }
    }
    if (delivered.size === 0) return 0;
    const sent = requests.filter(({ sequence }) => delivered.has(sequence));
    transport.retransmitRequestsSent(sent, nowMs);
    return sent.length;
  }

  retransmitStats() {
    return this.currentAudioTransport?.retransmitStats?.() ?? null;
  }

  receiverStats() {
    return this.currentAudioTransport?.stats() ?? null;
  }

  noteUplinkHealth(socket: RelaySocket, health: AudioUplinkHealth, nowMs: number,
    mix?: { playable: boolean; headroomMs: number }) {
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
    this.publisherHealthAt = performance.now();
    this.publisherInboundAt = Math.max(this.publisherInboundAt, this.publisherHealthAt);
    this.armUplinkHealthDeadline(socket, health.captureGeneration, 2);
    if (socket.readyState === WebSocket.OPEN && typeof socket.send === 'function') {
      try {
        socket.send(JSON.stringify({
          type: 'audio-uplink-health-ack',
          version: 1,
          captureGeneration: health.captureGeneration,
          ...(health.healthRequestId === undefined ? {} : { healthRequestId: health.healthRequestId }),
          pcm: {
            ...(mix === undefined ? {} : { mix }),
            acceptedFrameSerial: this.currentAcceptedFrameSerial,
            receivedEndSample: this.latestAcceptedFrameEndSample,
            sampleRate: this.currentSampleRate,
            receivedPacketSerial: this.currentAudioTransport?.stats()?.emittedPackets ?? 0,
            receivedSampleSerial: this.currentAudioTransport?.stats()?.emittedSamples ?? 0,
            mediaPath: this.mediaArrivalPath(nowMs),
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
    if (!Number.isFinite(this.publisherHealthAt)) {
      // Bound now: silence and the health give-up both count from here.
      this.publisherHealthAt = performance.now();
      this.publisherInboundAt = this.publisherHealthAt;
    }

    const check = () => {
      this.uplinkHealthDeadline = null;
      if (
        this.currentPublisher !== socket
        || socket.role !== 'publisher'
        || socket.audioPacketVersion !== 2
        || socket.captureGeneration !== captureGeneration
      ) return;
      const nowMs = performance.now();
      const silentForMs = nowMs - this.publisherInboundAt;
      const healthAgeMs = nowMs - this.publisherHealthAt;
      if (silentForMs < this.publisherControlSilenceMs && healthAgeMs < this.publisherHealthGiveUpMs) {
        schedule(Math.min(
          this.publisherControlSilenceMs - silentForMs,
          this.publisherHealthGiveUpMs - healthAgeMs,
        ));
        return;
      }
      try {
        socket.close(4000, 'publisher uplink health stale');
      } catch {
        try {
          socket.terminate();
        } catch {}
      }
    };
    const schedule = (delayMs: number) => {
      const timer = setTimeout(() => {
        if (this.uplinkHealthDeadline === timer) check();
      }, Math.max(1, delayMs));
      timer.unref?.();
      this.uplinkHealthDeadline = timer;
    };
    schedule(Math.min(
      this.publisherControlSilenceMs - (performance.now() - this.publisherInboundAt),
      this.publisherHealthGiveUpMs - (performance.now() - this.publisherHealthAt),
    ));
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
