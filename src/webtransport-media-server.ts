import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export type WebTransportCertificateHash = {
  algorithm: 'sha-256';
  valueBase64: string;
};

export type WebTransportMediaOffer = {
  preferred: 'webtransport';
  url: string;
  serverCertificateHashes?: WebTransportCertificateHash[];
};

export type WebTransportMediaConfig = {
  publicUrl: URL;
  bindHost: string;
  bindPort: number;
  certPath: string;
  keyPath: string;
  pinCertificate: boolean;
};

export type WebTransportMediaHooks = {
  authorize(ticket: string): boolean;
  onDatagram(ticket: string, packet: Buffer, nowMs: number): void;
};

export type WebTransportMediaServer = {
  available: boolean;
  offer(ticket: string): WebTransportMediaOffer | undefined;
  hasSession(ticket: string | null): boolean;
  stop(): Promise<void>;
};

const MAX_PINNED_CERT_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;

function requiredPath(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when WebTransport media is enabled.`);
  return value;
}

function validPort(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('RELAY_WEBTRANSPORT_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function parseWebTransportMediaConfig(env: NodeJS.ProcessEnv): WebTransportMediaConfig {
  const rawPublicUrl = env.RELAY_WEBTRANSPORT_PUBLIC_URL?.trim();
  if (!rawPublicUrl) throw new Error('RELAY_WEBTRANSPORT_PUBLIC_URL is required.');

  const publicUrl = new URL(rawPublicUrl);
  if (publicUrl.protocol !== 'https:') {
    throw new Error('RELAY_WEBTRANSPORT_PUBLIC_URL must use https:.');
  }
  if (publicUrl.username || publicUrl.password || publicUrl.hash) {
    throw new Error('RELAY_WEBTRANSPORT_PUBLIC_URL cannot contain credentials or a fragment.');
  }
  if (!publicUrl.port) {
    throw new Error(
      'RELAY_WEBTRANSPORT_PUBLIC_URL must include the dedicated UDP/HTTP3 port explicitly.',
    );
  }
  if (publicUrl.pathname === '/' || publicUrl.pathname === '') {
    publicUrl.pathname = '/media';
  }

  const bindPort = validPort(env.RELAY_WEBTRANSPORT_PORT, Number(publicUrl.port));
  return {
    publicUrl,
    bindHost: env.RELAY_WEBTRANSPORT_HOST?.trim() || '0.0.0.0',
    bindPort,
    certPath: requiredPath(env, 'RELAY_WEBTRANSPORT_CERT'),
    keyPath: requiredPath(env, 'RELAY_WEBTRANSPORT_KEY'),
    pinCertificate: env.RELAY_WEBTRANSPORT_PIN_CERT === '1',
  };
}

export function webTransportMediaConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebTransportMediaConfig | null {
  const rawPublicUrl = env.RELAY_WEBTRANSPORT_PUBLIC_URL?.trim();
  if (!rawPublicUrl) return null;

  try {
    return parseWebTransportMediaConfig(env);
  } catch (error) {
    console.warn(
      'Relay WebTransport media configuration is invalid; continuing with the WebSocket microphone fallback.',
      error,
    );
    return null;
  }
}

export function createWebTransportMediaTicket() {
  return randomBytes(24).toString('base64url');
}

export function pinnedCertificateHash(certPem: string): WebTransportCertificateHash {
  const certificate = new X509Certificate(certPem);
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (
    !Number.isFinite(validFrom)
    || !Number.isFinite(validTo)
    || validTo <= validFrom
    || validTo - validFrom >= MAX_PINNED_CERT_VALIDITY_MS
  ) {
    throw new Error(
      'Pinned WebTransport certificates must be X.509 certificates valid for less than 14 days.',
    );
  }

  if (certificate.publicKey.asymmetricKeyType !== 'ec') {
    throw new Error('Pinned WebTransport certificates must use an EC key (P-256 recommended).');
  }
  const details = certificate.publicKey.asymmetricKeyDetails;
  if (details?.namedCurve && details.namedCurve !== 'prime256v1') {
    throw new Error('Pinned WebTransport certificates must use the P-256/prime256v1 curve.');
  }

  return {
    algorithm: 'sha-256',
    valueBase64: createHash('sha256').update(certificate.raw).digest('base64'),
  };
}

function offerFor(
  config: WebTransportMediaConfig,
  ticket: string,
  certificateHash: WebTransportCertificateHash | null,
): WebTransportMediaOffer {
  const url = new URL(config.publicUrl);
  url.searchParams.set('ticket', ticket);
  return {
    preferred: 'webtransport',
    url: url.toString(),
    ...(certificateHash ? { serverCertificateHashes: [certificateHash] } : {}),
  };
}

function unavailableWebTransportMediaServer(error: unknown): WebTransportMediaServer {
  console.warn(
    'Relay WebTransport media is unavailable; continuing with the WebSocket microphone fallback.',
    error,
  );
  return {
    available: false,
    offer() {
      return undefined;
    },
    hasSession() {
      return false;
    },
    async stop() {},
  };
}

async function startConfiguredWebTransportMediaServer(
  config: WebTransportMediaConfig,
  hooks: WebTransportMediaHooks,
): Promise<WebTransportMediaServer> {
  const cert = readFileSync(config.certPath, 'utf8');
  const privKey = readFileSync(config.keyPath, 'utf8');
  const certificateHash = config.pinCertificate ? pinnedCertificateHash(cert) : null;
  const { Http3Server, quicheLoaded } = await import('@fails-components/webtransport');
  await quicheLoaded;

  const server = new Http3Server({
    port: config.bindPort,
    host: config.bindHost,
    secret: randomBytes(32).toString('hex'),
    cert,
    privKey,
  });

  server.startServer();
  await server.ready;

  const path = config.publicUrl.pathname;
  server.setRequestCallback(async (args: any) => {
    const rawPath = String(args.header?.[':path'] ?? '');
    const requestUrl = new URL(rawPath, 'https://relay.invalid');
    const ticket = requestUrl.searchParams.get('ticket') ?? '';
    const accepted = requestUrl.pathname === path && hooks.authorize(ticket);
    return {
      ...args,
      path,
      userData: accepted ? { ticket } : undefined,
      header: { ...args.header, ':path': path },
      status: accepted ? 200 : 403,
    };
  });

  const sessionStream = await server.sessionStream(path);
  const activeSessions = new Map<string, number>();
  let stopping = false;

  const addSession = (ticket: string) => {
    activeSessions.set(ticket, (activeSessions.get(ticket) ?? 0) + 1);
  };
  const removeSession = (ticket: string) => {
    const next = (activeSessions.get(ticket) ?? 1) - 1;
    if (next <= 0) activeSessions.delete(ticket);
    else activeSessions.set(ticket, next);
  };

  const consumeSession = async (session: any) => {
    const ticket = String(session.userData?.ticket ?? '');
    if (!ticket || !hooks.authorize(ticket)) {
      session.close({ closeCode: 403, reason: 'media ticket is no longer valid' });
      return;
    }

    await session.ready;
    addSession(ticket);
    const reader = session.datagrams.readable.getReader();
    try {
      while (!stopping) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!hooks.authorize(ticket)) {
          session.close({ closeCode: 403, reason: 'media ticket expired' });
          break;
        }
        if (value instanceof Uint8Array) {
          hooks.onDatagram(ticket, Buffer.from(value), performance.now());
        }
      }
    } catch {
      // Datagram/session failure is a transport event. The browser falls back
      // to WebSocket and the shared packet receiver keeps timeline authority.
    } finally {
      removeSession(ticket);
      try {
        reader.releaseLock();
      } catch {}
    }
  };

  void (async () => {
    const reader = sessionStream.getReader();
    try {
      while (!stopping) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) void consumeSession(value);
      }
    } catch {
      if (!stopping) console.error('WebTransport media session stream failed.');
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  })();

  return {
    available: true,
    offer(ticket) {
      return offerFor(config, ticket, certificateHash);
    },
    hasSession(ticket) {
      return Boolean(ticket && (activeSessions.get(ticket) ?? 0) > 0);
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      server.stopServer();
      try {
        await server.closed;
      } catch {}
    },
  };
}

export async function startWebTransportMediaServer(
  config: WebTransportMediaConfig,
  hooks: WebTransportMediaHooks,
): Promise<WebTransportMediaServer> {
  try {
    return await startConfiguredWebTransportMediaServer(config, hooks);
  } catch (error) {
    return unavailableWebTransportMediaServer(error);
  }
}

export type WebTransportMediaStarter = (
  config: WebTransportMediaConfig,
  hooks: WebTransportMediaHooks,
) => Promise<WebTransportMediaServer>;

/**
 * Owns the optional HTTP/3 media server resource lifecycle only. Mic lease,
 * capture authorization, packet acceptance, and fallback policy remain with
 * the caller and MicRuntime.
 */
export class WebTransportMediaRuntime {
  private server: WebTransportMediaServer | null = null;

  constructor(
    private readonly startServer: WebTransportMediaStarter = startWebTransportMediaServer,
  ) {}

  get started() {
    return this.server !== null;
  }

  get available() {
    return this.server?.available ?? false;
  }

  createTicket() {
    return this.server ? createWebTransportMediaTicket() : null;
  }

  hasSession(ticket: string | null) {
    return this.server?.hasSession(ticket) ?? false;
  }

  offer(ticket: string) {
    return this.server?.offer(ticket);
  }

  async start(config: WebTransportMediaConfig, hooks: WebTransportMediaHooks) {
    if (this.server) throw new Error('WebTransportMediaRuntime is already started.');
    this.server = await this.startServer(config, hooks);
    return this.server;
  }

  async stop() {
    const current = this.server;
    if (!current) return;
    await current.stop();
    if (this.server === current) this.server = null;
  }
}
