import { MicMediaPathRecovery } from './mic-media-path-recovery.js';
import {
  MAX_RETRANSMIT_REQUEST_SEQUENCES,
  decodeRetransmitRequest,
} from '../shared/retransmit-request.js';

const WEB_SOCKET_OPEN = 1;

/**
 * Ceiling for one QUIC datagram, in bytes.
 *
 * Deliberately below a 1200-byte QUIC packet rather than at it: the datagram
 * frame rides inside that packet, after UDP/IP and QUIC headers, so a budget
 * equal to the observed packet size still does not fit. 1000 leaves room for
 * those headers on any path that carries a conventional 1200-byte QUIC packet,
 * and splits one 20 ms 48 kHz mono chunk into two datagrams rather than many.
 */
export const DEFAULT_DATAGRAM_PACKET_BYTES_CEILING = 1000;

/**
 * Outgoing datagrams that may sit queued, in packets.
 *
 * Covers one 20 ms chunk's burst at the ceiling above with room to spare, and
 * no more: every queued datagram is delay on a live voice path, so a genuinely
 * backpressured link should still start dropping quickly rather than building
 * a backlog of audio that is already too late to be worth sending.
 */
export const DEFAULT_DATAGRAM_QUEUE_PACKETS = 4;

/**
 * Longest an accepted WebTransport datagram write may stay unresolved before
 * that media path is considered stalled. A realtime capture keeps producing
 * new packets, so the next packet after this deadline demotes the stalled path
 * and continues over WebSocket without replaying already-submitted datagrams.
 */
export const DEFAULT_DATAGRAM_WRITE_TIMEOUT_MS = 1000;

/**
 * Datagrams waiting for a free write slot, in packets and in age.
 *
 * The write slots above are held until the platform settles each write, which
 * happens on a later task. A main-thread stall releases its whole capture
 * backlog back to back, so without somewhere to wait every datagram past the
 * fourth was dropped as "congested" even though the network was idle. Each
 * packet carries its own capture position, so a few tens of milliseconds of
 * waiting costs no timeline accuracy - Relay places it by sample index and the
 * mix reads hundreds of milliseconds behind the frontier. The age bound keeps
 * a genuinely backpressured path dropping instead of building stale voice.
 * 48 packets holds the ~400 ms capture-dispatch budget at two datagrams per
 * 20 ms chunk.
 */
export const DEFAULT_DATAGRAM_BACKLOG_PACKETS = 48;
export const DEFAULT_DATAGRAM_BACKLOG_MS = 200;

/**
 * Recently sent media packets kept to answer Relay's retransmission requests.
 * About 1.3 s of 48 kHz audio at two datagrams per 20 ms chunk - longer than
 * Relay will ever hold a hole, so a request never names a packet already gone.
 */
export const DEFAULT_RETRANSMIT_BUFFER_PACKETS = 128;

/**
 * Backoff before re-offering WebTransport after a transport-level demotion.
 *
 * A phone moving between Wi-Fi and cellular, a NAT rebinding or one failed
 * write closes the datagram session, and the capture then stayed on the
 * WebSocket fallback until the control socket happened to re-register. The
 * same capture-scoped offer is retried instead. A recovery quarantine is a
 * deliberate verdict and is never retried here.
 */
export const DEFAULT_WEBTRANSPORT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000, 30_000]);
const AUDIO_PACKET_MAGIC = 0x4c52;
const AUDIO_PACKET_HEADER_BYTES = 24;

/** Generation and sequence of an AudioPacket v2, or null for anything else. */
function audioPacketIdentity(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < AUDIO_PACKET_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== AUDIO_PACKET_MAGIC || view.getUint8(2) !== 2) return null;
  return { generation: view.getUint32(4, true), sequence: view.getUint32(8, true) };
}

/**
 * WebSocket fallback must stay a realtime path too. 256 KiB at 48 kHz mono
 * PCM16 is about 2.7 seconds of stale voice, so keep a hard duration-derived
 * ceiling even when a legacy caller supplies a much larger byte threshold.
 */
export const DEFAULT_WEBSOCKET_BACKLOG_MS = 200;
export const DEFAULT_WEBSOCKET_PCM_SAMPLE_RATE = 48_000;
const PCM16_BYTES_PER_SAMPLE = 2;
const MEDIA_PATH_PACKET_COVERAGE_MIN_TOTAL = 32;

export function realtimeWebSocketBacklogBytes(
  sampleRate = DEFAULT_WEBSOCKET_PCM_SAMPLE_RATE,
  backlogMs = DEFAULT_WEBSOCKET_BACKLOG_MS,
) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('sampleRate must be positive');
  }
  if (!Number.isFinite(backlogMs) || backlogMs <= 0) {
    throw new RangeError('backlogMs must be positive');
  }
  return Math.max(1, Math.round(
    (sampleRate * PCM16_BYTES_PER_SAMPLE * backlogMs) / 1000,
  ));
}

function monotonicNowMs() {
  const value = globalThis.performance?.now?.();
  return Number.isFinite(value) ? value : Date.now();
}

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function outgoingByteLength(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  const byteLength = Number(value?.byteLength);
  return Number.isFinite(byteLength) && byteLength > 0 ? byteLength : 0;
}

function nonNegativeSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Media-plane boundary used by microphone capture.
 */
export class AudioTransport {
  maxPacketBytes() {
    return Number.POSITIVE_INFINITY;
  }

  send(_packet) {
    throw new Error('AudioTransport.send() must be implemented by an adapter.');
  }
}

export class WebSocketAudioTransport extends AudioTransport {
  constructor({
    maxBufferedBytes = 256 * 1024,
    realtimeBufferedBytes = realtimeWebSocketBacklogBytes(),
  } = {}) {
    super();
    if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 0) {
      throw new RangeError('maxBufferedBytes must be non-negative');
    }
    if (!Number.isFinite(realtimeBufferedBytes) || realtimeBufferedBytes <= 0) {
      throw new RangeError('realtimeBufferedBytes must be positive');
    }
    this.configuredMaxBufferedBytes = maxBufferedBytes;
    this.realtimeBufferedBytes = realtimeBufferedBytes;
    this.maxBufferedBytes = Math.min(maxBufferedBytes, realtimeBufferedBytes);
    this.socket = null;
  }

  setRealtimePcmSampleRate(sampleRate) {
    const realtimeBufferedBytes = realtimeWebSocketBacklogBytes(sampleRate);
    this.realtimeBufferedBytes = realtimeBufferedBytes;
    this.maxBufferedBytes = Math.min(this.configuredMaxBufferedBytes, realtimeBufferedBytes);
    return this.maxBufferedBytes;
  }

  bind(socket, { sampleRate } = {}) {
    if (sampleRate !== undefined) this.setRealtimePcmSampleRate(sampleRate);
    this.socket = socket;
  }

  unbind(socket = this.socket) {
    if (this.socket === socket) this.socket = null;
  }

  state() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) {
      return {
        ready: false,
        reason: 'disconnected',
        bufferedAmount: 0,
        maxPacketBytes: this.maxPacketBytes(),
        path: 'websocket',
      };
    }

    const bufferedAmount = Number(socket.bufferedAmount) || 0;
    if (bufferedAmount >= this.maxBufferedBytes) {
      return {
        ready: false,
        reason: 'congested',
        bufferedAmount,
        maxPacketBytes: this.maxPacketBytes(),
        path: 'websocket',
      };
    }

    return {
      ready: true,
      reason: null,
      bufferedAmount,
      maxPacketBytes: this.maxPacketBytes(),
      path: 'websocket',
    };
  }

  send(packet) {
    const state = this.state();
    if (!state.ready) return { ...state, sent: false };

    const packetBytes = outgoingByteLength(packet);
    if (packetBytes > 0 && state.bufferedAmount + packetBytes > this.maxBufferedBytes) {
      return {
        ...state,
        ready: false,
        sent: false,
        reason: 'congested',
      };
    }

    try {
      this.socket.send(packet);
      return { ...state, sent: true };
    } catch {
      return {
        ready: false,
        sent: false,
        reason: 'disconnected',
        bufferedAmount: state.bufferedAmount,
        maxPacketBytes: this.maxPacketBytes(),
        path: 'websocket',
      };
    }
  }
}

/**
 * Prefers direct HTTP/3 datagrams when the control plane offers them, while
 * keeping the WebSocket binary path as the compatibility fallback.
 *
 * There is one packet sequence for the capture regardless of which physical
 * path sends it. A packet is never duplicated onto both transports: if an
 * active datagram writer is backpressured the packet is dropped as timeline
 * evidence, and if the writer fails the *next* packet falls back to WebSocket.
 */
export class PreferredAudioTransport extends AudioTransport {
  constructor({
    maxBufferedBytes = 256 * 1024,
    minimumPacketBytes = 1,
    datagramPacketBytesCeiling = DEFAULT_DATAGRAM_PACKET_BYTES_CEILING,
    datagramQueuePackets = DEFAULT_DATAGRAM_QUEUE_PACKETS,
    datagramWriteTimeoutMs = DEFAULT_DATAGRAM_WRITE_TIMEOUT_MS,
    datagramBacklogPackets = DEFAULT_DATAGRAM_BACKLOG_PACKETS,
    datagramBacklogMs = DEFAULT_DATAGRAM_BACKLOG_MS,
    retransmitBufferPackets = DEFAULT_RETRANSMIT_BUFFER_PACKETS,
    webTransportRetryDelaysMs = DEFAULT_WEBTRANSPORT_RETRY_DELAYS_MS,
    setTimer = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer = (handle) => globalThis.clearTimeout(handle),
    holdMediaUntilPreference = false,
    initialPreferenceHoldMs = 1_500,
    WebTransportClass = globalThis.WebTransport,
    nowMs = monotonicNowMs,
  } = {}) {
    super();
    if (!Number.isInteger(minimumPacketBytes) || minimumPacketBytes < 1) {
      throw new RangeError('minimumPacketBytes must be a positive integer');
    }
    if (
      !Number.isInteger(datagramPacketBytesCeiling)
      || datagramPacketBytesCeiling < minimumPacketBytes
    ) {
      throw new RangeError('datagramPacketBytesCeiling must be an integer at least minimumPacketBytes');
    }
    if (!Number.isInteger(datagramQueuePackets) || datagramQueuePackets < 1) {
      throw new RangeError('datagramQueuePackets must be a positive integer');
    }
    if (!Number.isFinite(datagramWriteTimeoutMs) || datagramWriteTimeoutMs <= 0) {
      throw new RangeError('datagramWriteTimeoutMs must be positive');
    }
    if (!Number.isInteger(datagramBacklogPackets) || datagramBacklogPackets < 0) {
      throw new RangeError('datagramBacklogPackets must be a non-negative integer');
    }
    if (!Number.isFinite(datagramBacklogMs) || datagramBacklogMs <= 0) {
      throw new RangeError('datagramBacklogMs must be positive');
    }
    if (!Number.isInteger(retransmitBufferPackets) || retransmitBufferPackets < 0) {
      throw new RangeError('retransmitBufferPackets must be a non-negative integer');
    }
    if (
      !Array.isArray(webTransportRetryDelaysMs)
      || webTransportRetryDelaysMs.some((delay) => !Number.isFinite(delay) || delay <= 0)
    ) {
      throw new RangeError('webTransportRetryDelaysMs must be positive delays');
    }
    if (typeof holdMediaUntilPreference !== 'boolean') {
      throw new TypeError('holdMediaUntilPreference must be boolean');
    }
    if (!Number.isFinite(initialPreferenceHoldMs) || initialPreferenceHoldMs <= 0) {
      throw new RangeError('initialPreferenceHoldMs must be positive');
    }
    if (typeof nowMs !== 'function') {
      throw new TypeError('nowMs must be a function');
    }
    this.fallback = new WebSocketAudioTransport({ maxBufferedBytes });
    this.minimumPacketBytes = minimumPacketBytes;
    this.datagramPacketBytesCeiling = datagramPacketBytesCeiling;
    this.datagramQueuePackets = datagramQueuePackets;
    this.datagramWriteTimeoutMs = datagramWriteTimeoutMs;
    this.datagramBacklogPackets = datagramBacklogPackets;
    this.datagramBacklogMs = datagramBacklogMs;
    /** @type {{ bytes: Uint8Array, enqueuedAt: number, retransmit?: boolean }[]} */
    this.datagramBacklog = [];
    this.retransmitBufferPackets = retransmitBufferPackets;
    /** Sent packets of `retransmitGeneration`, by sequence, oldest first. */
    this.retransmitBuffer = new Map();
    this.retransmitGeneration = null;
    this.retransmitAnswered = new Set();
    this.webTransportRetryDelaysMs = [...webTransportRetryDelaysMs];
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** The offer a transport-level demotion may retry, while it still applies. */
    this.retryableOffer = null;
    this.webTransportRetryAttempt = 0;
    this.webTransportRetryTimer = null;
    this.holdMediaUntilPreference = holdMediaUntilPreference;
    this.initialPreferenceHoldMs = initialPreferenceHoldMs;
    // Phone publisher capture starts before Relay's registered/media offer can
    // return. In opt-in mode, preserve the sample timeline but do not let that
    // negotiation window leak PCM onto WebSocket before the first path choice.
    // The hold is bounded so a stalled WebTransport handshake cannot suppress
    // microphone media beyond the server's startup deadline.
    this.initialPreferenceResolved = !holdMediaUntilPreference;
    this.initialPreferenceHoldStartedAt = null;
    this.nowMs = nowMs;
    this.outstandingDatagramWrites = 0;
    this.pendingDatagramWrites = new Map();
    this.nextDatagramWriteId = 1;
    this.WebTransportClass = WebTransportClass;
    this.webTransport = null;
    this.datagramWriter = null;
    this.preferredUrl = null;
    this.lastWebTransportMaxPacketBytes = Number.POSITIVE_INFINITY;
    this.preferenceGeneration = 0;
    this.mediaPathRecovery = new MicMediaPathRecovery();
    this.publisherSocketEpoch = 0;
    this.publisherSocketListener = null;
    this.pendingPublisherHealth = [];
    this.sourceEligibilityEpoch = 0;
    this.lastMediaRecoveryDecision = null;
    this.resetStats();
  }

  resetStats() {
    this.telemetry = {
      webTransportAttempts: 0,
      webTransportConnections: 0,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webTransportBacklogQueued: 0,
      webTransportBacklogExpired: 0,
      webTransportRetries: 0,
      retransmittedPackets: 0,
      retransmitDatagramRequests: 0,
      webSocketPacketsSent: 0,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 0,
      webSocketSendFailures: 0,
      webSocketControlMessagesSent: 0,
      webSocketControlCongestedRejects: 0,
      webSocketControlDisconnectedRejects: 0,
      webSocketControlSendFailures: 0,
    };
    this.minWebTransportMaxPacketBytes = null;
    this.maxWebTransportMaxPacketBytes = null;
    this.mediaPathRecovery?.reset();
    this.pendingPublisherHealth = [];
    this.lastMediaRecoveryDecision = null;
  }

  resolveInitialPreference() {
    this.initialPreferenceResolved = true;
    this.initialPreferenceHoldStartedAt = null;
  }

  noteSourceIneligibleBoundary() {
    // Health ACKs are request-ordered but may arrive after a visibility edge.
    // Advance a local epoch so any snapshot sent before this source boundary is
    // consumed from the FIFO without being allowed to re-open diagnosis.
    this.sourceEligibilityEpoch += 1;
    this.mediaPathRecovery.noteSourceIneligibleBoundary();
  }

  resetOutstandingDatagramWrites() {
    this.pendingDatagramWrites.clear();
    this.outstandingDatagramWrites = 0;
  }

  /**
   * Datagrams that never reached the retired writer were never sent, so moving
   * them to the socket is not duplication. Still-fresh ones keep their place in
   * the capture order; stale ones become the same hole congestion would leave.
   */
  takeDatagramBacklog() {
    const backlog = this.datagramBacklog;
    this.datagramBacklog = [];
    return backlog;
  }

  expireDatagramBacklog(nowMs = Number(this.nowMs())) {
    // Scan the whole queue: a repeat is placed at the front with its own
    // enqueue time, so the head is not always the oldest entry.
    if (this.datagramBacklog.length === 0) return;
    const fresh = [];
    for (const entry of this.datagramBacklog) {
      if (nowMs - entry.enqueuedAt <= this.datagramBacklogMs) {
        fresh.push(entry);
        continue;
      }
      // A repeat is not a capture packet: its loss is not congestion evidence.
      if (entry.retransmit) continue;
      this.telemetry.webTransportBacklogExpired += 1;
      this.telemetry.webTransportCongestedRejects += 1;
    }
    if (fresh.length !== this.datagramBacklog.length) this.datagramBacklog = fresh;
  }

  flushDatagramBacklogToFallback(backlog) {
    const nowMs = Number(this.nowMs());
    for (const entry of backlog) {
      if (nowMs - entry.enqueuedAt > this.datagramBacklogMs) {
        if (entry.retransmit) continue;
        this.telemetry.webTransportBacklogExpired += 1;
        this.telemetry.webTransportCongestedRejects += 1;
        continue;
      }
      const result = this.fallback.send(entry.bytes);
      if (!entry.retransmit) this.recordFallbackResult(result);
    }
  }

  pumpDatagramBacklog() {
    if (!this.datagramWriter) return;
    this.expireDatagramBacklog();
    while (
      this.datagramWriter
      && this.datagramBacklog.length > 0
      && this.outstandingDatagramWrites < this.datagramQueuePackets
    ) {
      const entry = this.datagramBacklog.shift();
      this.writeDatagram(entry.bytes, { original: !entry.retransmit });
    }
  }

  oldestOutstandingDatagramWriteAgeMs() {
    if (this.pendingDatagramWrites.size === 0) return null;
    let oldestStartedAt = Number.POSITIVE_INFINITY;
    for (const startedAt of this.pendingDatagramWrites.values()) {
      oldestStartedAt = Math.min(oldestStartedAt, startedAt);
    }
    if (!Number.isFinite(oldestStartedAt)) return null;
    return Math.max(0, Number(this.nowMs()) - oldestStartedAt);
  }

  demoteStalledWebTransport() {
    if (!this.datagramWriter) return false;
    const oldestAgeMs = this.oldestOutstandingDatagramWriteAgeMs();
    if (oldestAgeMs === null || oldestAgeMs < this.datagramWriteTimeoutMs) return false;
    this.demoteWebTransport();
    return true;
  }

  observeWebTransportPacketBudget(value) {
    if (!Number.isInteger(value) || value <= 0) return;
    this.minWebTransportMaxPacketBytes = this.minWebTransportMaxPacketBytes === null
      ? value
      : Math.min(this.minWebTransportMaxPacketBytes, value);
    this.maxWebTransportMaxPacketBytes = this.maxWebTransportMaxPacketBytes === null
      ? value
      : Math.max(this.maxWebTransportMaxPacketBytes, value);
  }

  recordFallbackResult(result) {
    if (result.sent) {
      this.telemetry.webSocketPacketsSent += 1;
      return;
    }
    if (result.reason === 'congested') this.telemetry.webSocketCongestedRejects += 1;
    else if (result.reason === 'disconnected') this.telemetry.webSocketDisconnectedRejects += 1;
    else this.telemetry.webSocketSendFailures += 1;
  }

  recordControlFallbackResult(result) {
    if (result.sent) {
      this.telemetry.webSocketControlMessagesSent += 1;
      return;
    }
    if (result.reason === 'congested') this.telemetry.webSocketControlCongestedRejects += 1;
    else if (result.reason === 'disconnected') this.telemetry.webSocketControlDisconnectedRejects += 1;
    else this.telemetry.webSocketControlSendFailures += 1;
  }

  stats() {
    const path = this.datagramWriter ? 'webtransport' : 'websocket';
    const maxPacketBytes = this.datagramWriter
      ? this.currentWebTransportMaxPacketBytes()
      : null;
    return {
      path,
      maxPacketBytes: Number.isFinite(maxPacketBytes) ? maxPacketBytes : null,
      // The browser-reported min/max stay raw so a clamped run still shows what
      // the path claimed, next to the ceiling that was actually packetized to.
      minWebTransportMaxPacketBytes: this.minWebTransportMaxPacketBytes,
      maxWebTransportMaxPacketBytes: this.maxWebTransportMaxPacketBytes,
      datagramPacketBytesCeiling: this.datagramPacketBytesCeiling,
      datagramQueuePackets: this.datagramQueuePackets,
      datagramBacklogPackets: this.datagramBacklogPackets,
      datagramBacklogMs: this.datagramBacklogMs,
      retransmitBufferPackets: this.retransmitBufferPackets,
      // ProductStatus may surface the terminal bounded-recovery verdict while
      // keeping server flow freshness as the room Mic state authority.
      mediaRecoveryDegraded: this.mediaPathRecovery.status().degraded,
      datagramWriteTimeoutMs: this.datagramWriteTimeoutMs,
      ...this.telemetry,
    };
  }

  detachPublisherSocketListener() {
    const listener = this.publisherSocketListener;
    this.publisherSocketListener = null;
    if (!listener) return;
    try {
      listener.socket.removeEventListener?.('message', listener.handler);
    } catch {}
  }

  bind(socket, options) {
    this.detachPublisherSocketListener();
    this.pendingPublisherHealth = [];
    this.fallback.bind(socket, options);
    if (
      this.holdMediaUntilPreference
      && !this.initialPreferenceResolved
      && this.initialPreferenceHoldStartedAt === null
    ) {
      this.initialPreferenceHoldStartedAt = Number(this.nowMs());
    }
    const epoch = ++this.publisherSocketEpoch;
    if (typeof socket?.addEventListener === 'function') {
      const handler = (event) => this.observePublisherSocketMessage(socket, epoch, event);
      socket.addEventListener('message', handler);
      this.publisherSocketListener = { socket, handler };
    }
  }

  unbind(socket) {
    if (this.publisherSocketListener?.socket === socket) {
      this.detachPublisherSocketListener();
      this.pendingPublisherHealth = [];
    }
    this.fallback.unbind(socket);
  }

  observePublisherSocketMessage(socket, epoch, event) {
    if (
      socket?.readyState !== WEB_SOCKET_OPEN
      || epoch !== this.publisherSocketEpoch
      || this.fallback.socket !== socket
      || typeof event?.data !== 'string'
    ) return;
    // Cheap prefilter: only the two media-control messages are parsed here.
    if (
      !event.data.includes('"audio-retransmit-request"')
      && (
        this.pendingPublisherHealth.length < 1
        || !event.data.includes('"audio-uplink-health-ack"')
      )
    ) return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === 'audio-retransmit-request' && message?.version === 1) {
      this.answerRetransmitRequest(message);
      return;
    }
    if (this.pendingPublisherHealth.length < 1) return;
    if (message?.type !== 'audio-uplink-health-ack' || message?.version !== 1) return;

    const publisherHealth = this.pendingPublisherHealth[0];
    const ackGeneration = nonNegativeSafeInteger(message.captureGeneration);
    const acceptedFrameSerial = nonNegativeSafeInteger(message.pcm?.acceptedFrameSerial);
    const receivedPacketSerial = nonNegativeSafeInteger(message.pcm?.receivedPacketSerial);
    const receivedSampleSerial = nonNegativeSafeInteger(message.pcm?.receivedSampleSerial);
    if (
      ackGeneration === null
      || ackGeneration > 0xffff_ffff
      || acceptedFrameSerial === null
      || ackGeneration !== publisherHealth.captureGeneration
      || publisherHealth.socketEpoch !== epoch
    ) return;
    this.pendingPublisherHealth.shift();

    if (publisherHealth.sourceEligibilityEpoch !== this.sourceEligibilityEpoch) {
      // This ACK describes a health snapshot captured before a synchronous
      // source-suspension boundary (for example visibilitychange:hidden).
      // It is still valid control traffic, but it cannot consume the new
      // media-diagnosis baseline.
      return;
    }

    const serverMediaPath = message.pcm?.mediaPath === 'webtransport'
      || message.pcm?.mediaPath === 'websocket'
      ? message.pcm.mediaPath
      : null;
    const decision = this.mediaPathRecovery.observe({
      captureGeneration: ackGeneration,
      capturedSamples: publisherHealth.capturedSamples,
      serverAcceptedFrameSerial: acceptedFrameSerial,
      senderSubmittedPackets: publisherHealth.senderSubmittedPackets,
      senderFailedPackets: publisherHealth.senderFailedPackets,
      serverReceivedPacketSerial: receivedPacketSerial,
      serverReceivedSampleSerial: receivedSampleSerial,
      localCaptureBacklogDroppedSamples: publisherHealth.captureBacklogDroppedSamples,
      serverMediaPath,
      path: publisherHealth.path,
      socketEpoch: epoch,
      eligible: publisherHealth.eligible,
    });
    this.lastMediaRecoveryDecision = decision;

    if (decision.action === 'demote-webtransport') {
      this.demoteWebTransport();
      return;
    }
    if (decision.action !== 'replace-websocket') return;

    // Fence every late ACK from the retiring physical socket immediately. The
    // existing app close/reconnect lifecycle owns the actual same-generation
    // registration that follows; media recovery only requests that one bounded
    // replacement and never touches the capture graph.
    this.publisherSocketEpoch += 1;
    try {
      socket.close(4001, 'server PCM stalled');
    } catch {
      try { socket.close(); } catch {}
    }
  }

  sendControlJson(payload) {
    const result = this.fallback.send(JSON.stringify(payload));
    this.recordControlFallbackResult(result);
    if (result.sent && payload?.type === 'audio-uplink-health' && payload?.version === 1) {
      const captureGeneration = nonNegativeSafeInteger(payload.captureGeneration);
      const capturedSamples = nonNegativeSafeInteger(payload.capturedSamples);
      const captureBacklogDroppedSamples = nonNegativeSafeInteger(
        payload.droppedSamples?.captureBacklog,
      );
      // Coverage starts at the browser transport decision boundary. A media
      // packet rejected by the bounded realtime queue is a final timeline hole,
      // not an in-flight packet: app.js never replays congestion rejects.
      // Control-message congestion has separate counters and is not included.
      const submittedPacketTotal = this.telemetry.webSocketPacketsSent
        + this.telemetry.webTransportPacketsSubmitted
        + this.telemetry.webSocketCongestedRejects
        + this.telemetry.webTransportCongestedRejects;
      const quantitativeReady = Number.isSafeInteger(submittedPacketTotal)
        && submittedPacketTotal >= MEDIA_PATH_PACKET_COVERAGE_MIN_TOTAL;
      const senderSubmittedPackets = quantitativeReady ? submittedPacketTotal : null;
      const senderFailedPackets = quantitativeReady ? this.telemetry.webTransportSendFailures : null;
      const payloadPath = payload.transport?.path;
      const path = payloadPath === 'webtransport' || payloadPath === 'websocket'
        ? payloadPath
        : this.datagramWriter ? 'webtransport' : 'websocket';
      if (
        captureGeneration !== null
        && captureGeneration <= 0xffff_ffff
        && capturedSamples !== null
      ) {
        this.pendingPublisherHealth.push({
          captureGeneration,
          capturedSamples,
          captureBacklogDroppedSamples,
          senderSubmittedPackets,
          senderFailedPackets,
          path,
          socketEpoch: this.publisherSocketEpoch,
          sourceEligibilityEpoch: this.sourceEligibilityEpoch,
          // Local source/capture failures are not media-path evidence. A muted
          // MediaStreamTrack or a sustained worklet input gap can keep sample
          // time advancing with zero PCM, just as capture-dispatch backlog
          // advances the source cursor while intentionally dropping stale
          // chunks. Rebaseline WT/WS recovery across these boundaries instead
          // of spending bounded transport actions on a known non-live source.
          eligible: globalThis.document?.visibilityState !== 'hidden'
            && payload.inputMuted !== true
            && payload.inputGapActive !== true
            && payload.captureDispatch?.backlogActive !== true,
        });
      }
    }
    return result;
  }

  /**
   * The datagram budget this transport will actually packetize to.
   *
   * `maxDatagramSize` is what the browser is willing to accept from the page,
   * not what the QUIC path can carry: Chrome reports 65535 on a path whose
   * packets are ~1200 bytes. Believing it means a 20 ms PCM chunk goes out as
   * one ~1944-byte datagram, `writer.write()` rejects asynchronously, and the
   * generic write-failure handler demotes to WebSocket for the rest of the
   * capture. The rejection never reaches the `packet-too-large` path that
   * would have re-split it, because the synchronous size guard compared
   * against 65535 and let it through.
   *
   * So cap the budget at something a path MTU can hold. The raw browser value
   * is still recorded for diagnostics; only what we packetize to is clamped.
   */
  currentWebTransportMaxPacketBytes() {
    const live = Number(this.webTransport?.datagrams?.maxDatagramSize);
    if (Number.isInteger(live) && live > 0) {
      this.lastWebTransportMaxPacketBytes = live;
      this.observeWebTransportPacketBudget(live);
      return Math.min(live, this.datagramPacketBytesCeiling);
    }
    return Math.min(this.lastWebTransportMaxPacketBytes, this.datagramPacketBytesCeiling);
  }

  maxPacketBytes() {
    if (this.demoteStalledWebTransport()) return this.fallback.maxPacketBytes();
    if (!this.datagramWriter) return this.fallback.maxPacketBytes();
    const maxPacketBytes = this.currentWebTransportMaxPacketBytes();
    if (maxPacketBytes < this.minimumPacketBytes) {
      this.demoteWebTransport();
      return this.fallback.maxPacketBytes();
    }
    return maxPacketBytes;
  }

  state() {
    if (this.demoteStalledWebTransport()) return this.fallback.state();
    if (this.datagramWriter) {
      const maxPacketBytes = this.maxPacketBytes();
      if (!this.datagramWriter) return this.fallback.state();
      this.expireDatagramBacklog();
      const ready = this.outstandingDatagramWrites < this.datagramQueuePackets
        || this.datagramBacklog.length < this.datagramBacklogPackets;
      return {
        ready,
        reason: ready ? null : 'congested',
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    }
    return this.fallback.state();
  }

  async prefer(offer, { retry = false } = {}) {
    if (!retry) {
      // A fresh offer from Relay restarts the retry schedule for that offer.
      this.cancelWebTransportRetry();
      this.webTransportRetryAttempt = 0;
      this.retryableOffer = offer?.preferred === 'webtransport' && offer.url ? offer : null;
    }
    if (this.mediaPathRecovery.quarantineWebTransport()) {
      this.retryableOffer = null;
      this.closeWebTransport();
      this.resolveInitialPreference();
      return false;
    }
    if (!offer || offer.preferred !== 'webtransport' || !offer.url) {
      this.closeWebTransport();
      this.resolveInitialPreference();
      return false;
    }
    if (!this.WebTransportClass) {
      this.closeWebTransport();
      this.resolveInitialPreference();
      return false;
    }
    // A control WebSocket reconnect for the same capture re-advertises the
    // same media ticket. Keeping that live session must also keep its write
    // generation: bumping the generation before this early return would orphan
    // in-flight writes from the very writer/transport we are retaining.
    if (
      this.datagramWriter
      && this.webTransport
      && this.preferredUrl === offer.url
    ) {
      this.resolveInitialPreference();
      return true;
    }

    const generation = ++this.preferenceGeneration;
    this.closeWebTransport(false);
    this.telemetry.webTransportAttempts += 1;

    const hashes = Array.isArray(offer.serverCertificateHashes)
      ? offer.serverCertificateHashes
        .filter((hash) => hash?.algorithm === 'sha-256' && typeof hash.valueBase64 === 'string')
        .map((hash) => ({ algorithm: 'sha-256', value: base64Bytes(hash.valueBase64) }))
      : [];
    const options = {
      requireUnreliable: true,
      congestionControl: 'low-latency',
      ...(hashes.length > 0 ? { serverCertificateHashes: hashes } : {}),
    };

    let transport;
    try {
      transport = new this.WebTransportClass(offer.url, options);
      await transport.ready;
      if (generation !== this.preferenceGeneration) {
        try { transport.close(); } catch {}
        return false;
      }

      const maxPacketBytes = Number(transport.datagrams?.maxDatagramSize);
      if (!Number.isInteger(maxPacketBytes) || maxPacketBytes < this.minimumPacketBytes) {
        try { transport.close(); } catch {}
        if (generation === this.preferenceGeneration) this.resolveInitialPreference();
        return false;
      }

      // One 20 ms chunk is packetized to several datagrams and written in one
      // synchronous pass. The default outgoing high-water mark is 1, so the
      // first write takes the only slot and every later datagram of the same
      // chunk sees desiredSize 0 and is dropped as congested - exactly half the
      // capture at two datagrams per chunk, with nothing actually congested.
      //
      // Queue depth is latency for realtime audio, so keep it just past one
      // chunk's burst rather than generous: still shallow enough that a truly
      // backpressured path drops promptly instead of buffering stale voice.
      // Best effort only, and deliberately not depended on. outgoingHighWaterMark
      // sizes the user agent's own datagram buffer; the writable stream's
      // queuing strategy stays at one, so writer.desiredSize reports whether a
      // write is in flight rather than whether the path is congested. Raising
      // this was accepted by the browser and changed nothing, which is why
      // backpressure is now counted here instead of read from the stream.
      try {
        transport.datagrams.outgoingHighWaterMark = this.datagramQueuePackets;
      } catch {}

      const writable = transport.datagrams.writable ?? transport.datagrams.createWritable();
      const writer = writable.getWriter();
      this.webTransport = transport;
      this.datagramWriter = writer;
      this.resetOutstandingDatagramWrites();
      this.preferredUrl = offer.url;
      this.lastWebTransportMaxPacketBytes = maxPacketBytes;
      this.observeWebTransportPacketBudget(maxPacketBytes);
      this.telemetry.webTransportConnections += 1;
      this.resolveInitialPreference();
      void this.readInboundDatagrams(transport);
      Promise.resolve(transport.closed).then(
        () => this.demoteWebTransport(transport),
        () => this.demoteWebTransport(transport),
      );
      return true;
    } catch {
      // A candidate can become a live HTTP/3 session before its datagram writer
      // is installed. If setup fails after `ready`, it is not `this.webTransport`
      // yet, so demoting the active slot alone would leave that candidate alive
      // on the server while the browser has already fallen back to WebSocket.
      if (transport && transport !== this.webTransport) {
        try { transport.close(); } catch {}
      }
      if (generation === this.preferenceGeneration) {
        this.demoteWebTransport();
        this.resolveInitialPreference();
      }
      return false;
    }
  }

  demoteWebTransport(transport = this.webTransport) {
    if (transport && this.webTransport && transport !== this.webTransport) return;
    const writer = this.datagramWriter;
    const demoted = this.webTransport;
    const wasActive = Boolean(this.webTransport || this.datagramWriter);
    this.webTransport = null;
    this.datagramWriter = null;
    this.preferredUrl = null;
    this.lastWebTransportMaxPacketBytes = Number.POSITIVE_INFINITY;
    this.resetOutstandingDatagramWrites();
    if (wasActive) this.telemetry.webTransportDemotions += 1;
    if (writer) {
      try { writer.releaseLock(); } catch {}
    }
    this.flushDatagramBacklogToFallback(this.takeDatagramBacklog());
    if (wasActive) this.scheduleWebTransportRetry();
    // Releasing the writer stops this page sending datagrams, but it leaves the
    // session open, and the server reads liveness from the session rather than
    // from traffic. Without this close, micMediaPath() keeps answering
    // 'webtransport' for a capture whose PCM has entirely moved to the socket.
    if (demoted) {
      try { demoted.close(); } catch {}
    }
  }

  cancelWebTransportRetry() {
    if (this.webTransportRetryTimer !== null) {
      try { this.clearTimer(this.webTransportRetryTimer); } catch {}
    }
    this.webTransportRetryTimer = null;
  }

  scheduleWebTransportRetry() {
    if (
      this.webTransportRetryTimer !== null
      || !this.retryableOffer
      || this.mediaPathRecovery.quarantineWebTransport()
      || this.webTransportRetryDelaysMs.length === 0
    ) return;
    const index = Math.min(this.webTransportRetryAttempt, this.webTransportRetryDelaysMs.length - 1);
    const offer = this.retryableOffer;
    const generation = this.preferenceGeneration;
    this.webTransportRetryAttempt += 1;
    this.webTransportRetryTimer = this.setTimer(() => {
      this.webTransportRetryTimer = null;
      // A newer offer, a close or an explicit preference change owns the path.
      if (
        this.retryableOffer !== offer
        || this.preferenceGeneration !== generation
        || this.datagramWriter
        || !this.fallback.socket
      ) return;
      this.telemetry.webTransportRetries += 1;
      void this.prefer(offer, { retry: true }).then((preferred) => {
        if (!preferred && this.retryableOffer === offer && !this.datagramWriter) {
          this.scheduleWebTransportRetry();
        }
      });
    }, this.webTransportRetryDelaysMs[index]);
  }

  closeWebTransport(incrementGeneration = true, { flushBacklog = true } = {}) {
    if (incrementGeneration) this.preferenceGeneration += 1;
    const transport = this.webTransport;
    const writer = this.datagramWriter;
    this.webTransport = null;
    this.datagramWriter = null;
    this.preferredUrl = null;
    this.lastWebTransportMaxPacketBytes = Number.POSITIVE_INFINITY;
    this.resetOutstandingDatagramWrites();
    const backlog = this.takeDatagramBacklog();
    if (flushBacklog) this.flushDatagramBacklogToFallback(backlog);
    if (writer) {
      try { writer.releaseLock(); } catch {}
    }
    if (transport) {
      try { transport.close(); } catch {}
    }
  }

  close() {
    this.detachPublisherSocketListener();
    this.initialPreferenceResolved = !this.holdMediaUntilPreference;
    this.initialPreferenceHoldStartedAt = null;
    this.publisherSocketEpoch += 1;
    this.mediaPathRecovery.reset();
    this.pendingPublisherHealth = [];
    this.lastMediaRecoveryDecision = null;
    // Capture teardown: nothing queued belongs to a live capture any more.
    this.retryableOffer = null;
    this.webTransportRetryAttempt = 0;
    this.cancelWebTransportRetry();
    this.closeWebTransport(true, { flushBacklog: false });
    this.fallback.unbind();
    this.clearRetransmitBuffer();
  }

  clearRetransmitBuffer() {
    this.retransmitBuffer.clear();
    this.retransmitAnswered.clear();
    this.retransmitGeneration = null;
  }

  /** Keeps a sent capture packet long enough to answer a repeat request. */
  rememberForRetransmit(bytes) {
    if (this.retransmitBufferPackets <= 0) return;
    const identity = audioPacketIdentity(bytes);
    if (!identity) return;
    if (identity.generation !== this.retransmitGeneration) {
      this.clearRetransmitBuffer();
      this.retransmitGeneration = identity.generation;
    }
    this.retransmitBuffer.delete(identity.sequence);
    this.retransmitBuffer.set(identity.sequence, bytes);
    while (this.retransmitBuffer.size > this.retransmitBufferPackets) {
      const oldest = this.retransmitBuffer.keys().next().value;
      this.retransmitBuffer.delete(oldest);
      this.retransmitAnswered.delete(oldest);
    }
  }

  /**
   * Repeats packets Relay reports missing, once each, on whatever path is
   * active now. A repeat carries the original sequence and capture position,
   * so Relay places it exactly where the lost packet belonged.
   */
  answerRetransmitRequest(message) {
    const generation = nonNegativeSafeInteger(message.captureGeneration);
    if (
      generation === null
      || generation !== this.retransmitGeneration
      || !Array.isArray(message.sequences)
    ) return 0;

    let answered = 0;
    for (const value of message.sequences.slice(0, MAX_RETRANSMIT_REQUEST_SEQUENCES)) {
      const sequence = nonNegativeSafeInteger(value);
      if (sequence === null || this.retransmitAnswered.has(sequence)) continue;
      const bytes = this.retransmitBuffer.get(sequence);
      if (!bytes) continue;
      this.retransmitAnswered.add(sequence);
      if (this.resendPacket(bytes)) {
        answered += 1;
        this.telemetry.retransmittedPackets += 1;
      }
    }
    return answered;
  }

  /**
   * Relay sends retransmission requests down the same direct session the
   * repeats travel back on. The loop ends with the session; anything that is
   * not a request is ignored.
   */
  async readInboundDatagrams(transport) {
    const readable = transport?.datagrams?.readable;
    if (!readable || typeof readable.getReader !== 'function') return;
    let reader;
    try {
      reader = readable.getReader();
    } catch {
      return;
    }
    try {
      while (transport === this.webTransport) {
        const { done, value } = await reader.read();
        if (done || transport !== this.webTransport) break;
        const request = decodeRetransmitRequest(value);
        if (request) {
          this.telemetry.retransmitDatagramRequests += 1;
          this.answerRetransmitRequest(request);
        }
      }
    } catch {
      // The session closed or failed; its demotion is handled elsewhere.
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  resendPacket(bytes) {
    if (this.datagramWriter && !this.demoteStalledWebTransport()) {
      if (
        this.datagramBacklog.length === 0
        && this.outstandingDatagramWrites < this.datagramQueuePackets
      ) {
        return this.writeDatagram(bytes, { original: false });
      }
      if (this.datagramBacklog.length >= this.datagramBacklogPackets) return false;
      // A repeat is already late: it goes ahead of fresh audio that still has
      // its whole budget.
      this.datagramBacklog.unshift({ bytes, enqueuedAt: Number(this.nowMs()), retransmit: true });
      return true;
    }
    return this.fallback.send(bytes).sent;
  }

  send(packet) {
    const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
    const result = this.sendMedia(packet);
    if (result.sent) this.rememberForRetransmit(bytes);
    return result;
  }

  sendMedia(packet) {
    if (!this.initialPreferenceResolved && !this.datagramWriter) {
      const startedAt = this.initialPreferenceHoldStartedAt;
      const holdAgeMs = startedAt === null
        ? 0
        : Math.max(0, Number(this.nowMs()) - startedAt);
      if (holdAgeMs >= this.initialPreferenceHoldMs) {
        this.resolveInitialPreference();
      } else {
        return {
          ready: false,
          sent: false,
          reason: 'disconnected',
          bufferedAmount: 0,
          maxPacketBytes: this.fallback.maxPacketBytes(),
          path: 'websocket',
        };
      }
    }

    if (this.demoteStalledWebTransport()) {
      const result = this.fallback.send(packet);
      this.recordFallbackResult(result);
      return result;
    }

    const writer = this.datagramWriter;
    if (!writer) {
      const result = this.fallback.send(packet);
      this.recordFallbackResult(result);
      return result;
    }

    const maxPacketBytes = this.currentWebTransportMaxPacketBytes();
    if (maxPacketBytes < this.minimumPacketBytes) {
      this.telemetry.webTransportPacketTooLargeRejects += 1;
      this.demoteWebTransport();
      return {
        ready: false,
        sent: false,
        reason: 'packet-too-large',
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    }

    const packetBytes = Number(packet?.byteLength);
    if (!Number.isFinite(packetBytes) || packetBytes < 1 || packetBytes > maxPacketBytes) {
      this.telemetry.webTransportPacketTooLargeRejects += 1;
      return {
        ready: false,
        sent: false,
        reason: 'packet-too-large',
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    }

    const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
    this.expireDatagramBacklog();
    if (
      this.datagramBacklog.length > 0
      || this.outstandingDatagramWrites >= this.datagramQueuePackets
    ) {
      // Order matters to the receiver's reorder window: once anything waits,
      // every later datagram waits behind it.
      if (this.datagramBacklog.length >= this.datagramBacklogPackets) {
        this.telemetry.webTransportCongestedRejects += 1;
        return {
          ready: false,
          sent: false,
          reason: 'congested',
          bufferedAmount: 0,
          maxPacketBytes,
          path: 'webtransport',
        };
      }
      this.datagramBacklog.push({ bytes, enqueuedAt: Number(this.nowMs()) });
      this.telemetry.webTransportBacklogQueued += 1;
      return {
        ready: true,
        sent: true,
        queued: true,
        reason: null,
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    }

    if (!this.writeDatagram(bytes)) {
      return {
        ready: false,
        sent: false,
        reason: 'disconnected',
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    }
    return {
      ready: true,
      sent: true,
      reason: null,
      bufferedAmount: 0,
      maxPacketBytes,
      path: 'webtransport',
    };
  }

  /**
   * Hands one datagram to the active writer. False means the path just failed.
   * Repeats are not `original`: coverage telemetry counts each capture packet
   * once, however many times it had to be sent.
   */
  writeDatagram(bytes, { original = true } = {}) {
    const writer = this.datagramWriter;
    if (!writer) return false;
    try {
      const transport = this.webTransport;
      const generation = this.preferenceGeneration;
      const writeId = this.nextDatagramWriteId++;
      if (original) this.telemetry.webTransportPacketsSubmitted += 1;
      this.pendingDatagramWrites.set(writeId, Number(this.nowMs()));
      this.outstandingDatagramWrites = this.pendingDatagramWrites.size;
      // A write belongs to the transport generation that submitted it. The
      // promise may settle after Mic teardown/restart has already installed a
      // newer WebTransport; that stale completion must not demote the new
      // capture, contaminate its transport-health evidence, or decrement an
      // in-flight count that now belongs to a different session.
      const ownsCapture = () => generation === this.preferenceGeneration
        && writer === this.datagramWriter
        && transport === this.webTransport;
      const settle = () => {
        if (!ownsCapture()) return;
        this.pendingDatagramWrites.delete(writeId);
        this.outstandingDatagramWrites = this.pendingDatagramWrites.size;
      };
      Promise.resolve(writer.write(bytes)).then(() => {
        settle();
        if (ownsCapture()) this.pumpDatagramBacklog();
      }, () => {
        if (!ownsCapture()) return;
        settle();
        this.telemetry.webTransportSendFailures += 1;
        this.demoteWebTransport(transport);
      });
      return true;
    } catch {
      this.telemetry.webTransportSendFailures += 1;
      this.demoteWebTransport();
      return false;
    }
  }
}
