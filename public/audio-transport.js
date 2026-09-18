import { MicMediaPathRecovery } from './mic-media-path-recovery.js';

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
    holdMediaUntilPreference = false,
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
    if (typeof holdMediaUntilPreference !== 'boolean') {
      throw new TypeError('holdMediaUntilPreference must be boolean');
    }
    if (typeof nowMs !== 'function') {
      throw new TypeError('nowMs must be a function');
    }
    this.fallback = new WebSocketAudioTransport({ maxBufferedBytes });
    this.minimumPacketBytes = minimumPacketBytes;
    this.datagramPacketBytesCeiling = datagramPacketBytesCeiling;
    this.datagramQueuePackets = datagramQueuePackets;
    this.datagramWriteTimeoutMs = datagramWriteTimeoutMs;
    this.holdMediaUntilPreference = holdMediaUntilPreference;
    // Phone publisher capture starts before Relay's registered/media offer can
    // return. In opt-in mode, preserve the sample timeline but do not let that
    // negotiation window leak PCM onto WebSocket before the first path choice.
    this.initialPreferenceResolved = !holdMediaUntilPreference;
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

  resetOutstandingDatagramWrites() {
    this.pendingDatagramWrites.clear();
    this.outstandingDatagramWrites = 0;
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
      || this.pendingPublisherHealth.length < 1
    ) return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type !== 'audio-uplink-health-ack' || message?.version !== 1) return;

    const publisherHealth = this.pendingPublisherHealth[0];
    const ackGeneration = nonNegativeSafeInteger(message.captureGeneration);
    const acceptedFrameSerial = nonNegativeSafeInteger(message.pcm?.acceptedFrameSerial);
    const receivedPacketSerial = nonNegativeSafeInteger(message.pcm?.receivedPacketSerial);
    if (
      ackGeneration === null
      || ackGeneration > 0xffff_ffff
      || acceptedFrameSerial === null
      || ackGeneration !== publisherHealth.captureGeneration
      || publisherHealth.socketEpoch !== epoch
    ) return;
    this.pendingPublisherHealth.shift();

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
          senderSubmittedPackets,
          senderFailedPackets,
          path,
          socketEpoch: this.publisherSocketEpoch,
          eligible: globalThis.document?.visibilityState !== 'hidden',
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
      const ready = this.outstandingDatagramWrites < this.datagramQueuePackets;
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

  async prefer(offer) {
    if (this.mediaPathRecovery.quarantineWebTransport()) {
      this.closeWebTransport();
      this.initialPreferenceResolved = true;
      return false;
    }
    if (!offer || offer.preferred !== 'webtransport' || !offer.url) {
      this.closeWebTransport();
      this.initialPreferenceResolved = true;
      return false;
    }
    if (!this.WebTransportClass) {
      this.closeWebTransport();
      this.initialPreferenceResolved = true;
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
      this.initialPreferenceResolved = true;
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
        if (generation === this.preferenceGeneration) this.initialPreferenceResolved = true;
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
      this.initialPreferenceResolved = true;
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
        this.initialPreferenceResolved = true;
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
    // Releasing the writer stops this page sending datagrams, but it leaves the
    // session open, and the server reads liveness from the session rather than
    // from traffic. Without this close, micMediaPath() keeps answering
    // 'webtransport' for a capture whose PCM has entirely moved to the socket.
    if (demoted) {
      try { demoted.close(); } catch {}
    }
  }

  closeWebTransport(incrementGeneration = true) {
    if (incrementGeneration) this.preferenceGeneration += 1;
    const transport = this.webTransport;
    const writer = this.datagramWriter;
    this.webTransport = null;
    this.datagramWriter = null;
    this.preferredUrl = null;
    this.lastWebTransportMaxPacketBytes = Number.POSITIVE_INFINITY;
    this.resetOutstandingDatagramWrites();
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
    this.publisherSocketEpoch += 1;
    this.mediaPathRecovery.reset();
    this.pendingPublisherHealth = [];
    this.lastMediaRecoveryDecision = null;
    this.closeWebTransport();
    this.fallback.unbind();
  }

  send(packet) {
    if (!this.initialPreferenceResolved && !this.datagramWriter) {
      return {
        ready: false,
        sent: false,
        reason: 'disconnected',
        bufferedAmount: 0,
        maxPacketBytes: this.fallback.maxPacketBytes(),
        path: 'websocket',
      };
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

    if (this.outstandingDatagramWrites >= this.datagramQueuePackets) {
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

    try {
      const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
      const transport = this.webTransport;
      const generation = this.preferenceGeneration;
      const writeId = this.nextDatagramWriteId++;
      this.telemetry.webTransportPacketsSubmitted += 1;
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
      Promise.resolve(writer.write(bytes)).then(settle, () => {
        if (!ownsCapture()) return;
        settle();
        this.telemetry.webTransportSendFailures += 1;
        this.demoteWebTransport(transport);
      });
      return {
        ready: true,
        sent: true,
        reason: null,
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    } catch {
      this.telemetry.webTransportSendFailures += 1;
      this.demoteWebTransport();
      return {
        ready: false,
        sent: false,
        reason: 'disconnected',
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    }
  }
}
