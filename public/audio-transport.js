const WEB_SOCKET_OPEN = 1;

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
    WebTransportClass = globalThis.WebTransport,
  } = {}) {
    super();
    if (!Number.isInteger(minimumPacketBytes) || minimumPacketBytes < 1) {
      throw new RangeError('minimumPacketBytes must be a positive integer');
    }
    this.fallback = new WebSocketAudioTransport({ maxBufferedBytes });
    this.minimumPacketBytes = minimumPacketBytes;
    this.WebTransportClass = WebTransportClass;
    this.webTransport = null;
    this.datagramWriter = null;
    this.preferredUrl = null;
    this.lastWebTransportMaxPacketBytes = Number.POSITIVE_INFINITY;
    this.preferenceGeneration = 0;
  }

  bind(socket) {
    this.fallback.bind(socket);
  }

  unbind(socket) {
    this.fallback.unbind(socket);
  }

  currentWebTransportMaxPacketBytes() {
    const live = Number(this.webTransport?.datagrams?.maxDatagramSize);
    if (Number.isInteger(live) && live > 0) {
      this.lastWebTransportMaxPacketBytes = live;
      return live;
    }
    return this.lastWebTransportMaxPacketBytes;
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

      const writable = transport.datagrams.writable ?? transport.datagrams.createWritable();
      const writer = writable.getWriter();
      this.webTransport = transport;
      this.datagramWriter = writer;
      this.preferredUrl = offer.url;
      this.lastWebTransportMaxPacketBytes = maxPacketBytes;
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
    this.webTransport = null;
    this.datagramWriter = null;
    this.preferredUrl = null;
    this.lastWebTransportMaxPacketBytes = Number.POSITIVE_INFINITY;
    if (writer) {
      try { writer.releaseLock(); } catch {}
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
    if (!writer) return this.fallback.send(packet);

    const maxPacketBytes = this.currentWebTransportMaxPacketBytes();
    if (maxPacketBytes < this.minimumPacketBytes) {
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
      Promise.resolve(writer.write(bytes)).catch(() => this.demoteWebTransport());
      return {
        ready: true,
        sent: true,
        reason: null,
        bufferedAmount: 0,
        maxPacketBytes,
        path: 'webtransport',
      };
    } catch {
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
