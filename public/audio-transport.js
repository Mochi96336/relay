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

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
  constructor({ maxBufferedBytes = 256 * 1024 } = {}) {
    super();
    if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 0) {
      throw new RangeError('maxBufferedBytes must be non-negative');
    }
    this.maxBufferedBytes = maxBufferedBytes;
    this.socket = null;
  }

  bind(socket) {
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
    WebTransportClass = globalThis.WebTransport,
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
    this.fallback = new WebSocketAudioTransport({ maxBufferedBytes });
    this.minimumPacketBytes = minimumPacketBytes;
    this.datagramPacketBytesCeiling = datagramPacketBytesCeiling;
    this.datagramQueuePackets = datagramQueuePackets;
    this.WebTransportClass = WebTransportClass;
    this.webTransport = null;
    this.datagramWriter = null;
    this.preferredUrl = null;
    this.lastWebTransportMaxPacketBytes = Number.POSITIVE_INFINITY;
    this.preferenceGeneration = 0;
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
    };
    this.minWebTransportMaxPacketBytes = null;
    this.maxWebTransportMaxPacketBytes = null;
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
      ...this.telemetry,
    };
  }

  bind(socket) {
    this.fallback.bind(socket);
  }

  unbind(socket) {
    this.fallback.unbind(socket);
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
    if (!this.datagramWriter) return this.fallback.maxPacketBytes();
    const maxPacketBytes = this.currentWebTransportMaxPacketBytes();
    if (maxPacketBytes < this.minimumPacketBytes) {
      this.demoteWebTransport();
      return this.fallback.maxPacketBytes();
    }
    return maxPacketBytes;
  }

  state() {
    if (this.datagramWriter) {
      const desiredSize = Number(this.datagramWriter.desiredSize);
      const maxPacketBytes = this.maxPacketBytes();
      if (!this.datagramWriter) return this.fallback.state();
      return {
        ready: Number.isNaN(desiredSize) || desiredSize > 0,
        reason: Number.isNaN(desiredSize) || desiredSize > 0 ? null : 'congested',
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    }
    return this.fallback.state();
  }

  async prefer(offer) {
    const generation = ++this.preferenceGeneration;
    if (!offer || offer.preferred !== 'webtransport' || !offer.url) {
      this.closeWebTransport();
      return false;
    }
    if (!this.WebTransportClass) {
      this.closeWebTransport();
      return false;
    }
    if (this.datagramWriter && this.preferredUrl === offer.url) return true;

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
      try {
        transport.datagrams.outgoingHighWaterMark = this.datagramQueuePackets;
      } catch {}

      const writable = transport.datagrams.writable ?? transport.datagrams.createWritable();
      const writer = writable.getWriter();
      this.webTransport = transport;
      this.datagramWriter = writer;
      this.preferredUrl = offer.url;
      this.lastWebTransportMaxPacketBytes = maxPacketBytes;
      this.observeWebTransportPacketBudget(maxPacketBytes);
      this.telemetry.webTransportConnections += 1;
      Promise.resolve(transport.closed).then(
        () => this.demoteWebTransport(transport),
        () => this.demoteWebTransport(transport),
      );
      return true;
    } catch {
      if (generation === this.preferenceGeneration) this.demoteWebTransport(transport);
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
    if (writer) {
      try { writer.releaseLock(); } catch {}
    }
    if (transport) {
      try { transport.close(); } catch {}
    }
  }

  close() {
    this.closeWebTransport();
    this.fallback.unbind();
  }

  send(packet) {
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

    const desiredSize = Number(writer.desiredSize);
    if (!Number.isNaN(desiredSize) && desiredSize <= 0) {
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
      this.telemetry.webTransportPacketsSubmitted += 1;
      Promise.resolve(writer.write(bytes)).catch(() => {
        // A write belongs to the transport generation that submitted it. The
        // promise may reject after Mic teardown/restart has already installed a
        // newer WebTransport; that stale completion must not demote the new
        // capture or contaminate its transport-health evidence.
        if (
          generation !== this.preferenceGeneration
          || writer !== this.datagramWriter
          || transport !== this.webTransport
        ) return;
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
