import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpsServer } from 'node:https';

import type { WebTransportMediaConfig } from './webtransport-media-server.js';

/**
 * A second door to Relay's WebSocket that skips the HTTPS tunnel.
 *
 * Pages are served through Cloudflare, and from HiNet Cloudflare routes Relay
 * to San Jose: a Mic in Taiwan whose datagrams reach the Pi in 13 ms waits
 * about 310 ms for every control round trip, and its WebSocket fallback audio
 * takes the same detour. The WebTransport host already resolves straight to
 * the Pi and holds a certificate for its name, so the same name and
 * certificate serve a TLS WebSocket on a TCP port next to the UDP one.
 *
 * Only the socket is offered here; pages and status stay on the tunnel.
 */
export type DirectSocketConfig = {
  bindHost: string;
  bindPort: number;
  publicUrl: URL;
  certPath: string;
  keyPath: string;
};

export function directSocketConfig(
  media: WebTransportMediaConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): DirectSocketConfig | null {
  const raw = env.RELAY_DIRECT_SOCKET_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.warn('RELAY_DIRECT_SOCKET_PORT must be an integer from 1 to 65535; the direct socket stays off.');
    return null;
  }
  if (!media) {
    console.warn('The direct socket needs the WebTransport host and certificate; it stays off.');
    return null;
  }
  const publicUrl = new URL(`wss://${media.publicUrl.hostname}:${port}/ws`);
  return {
    bindHost: media.bindHost,
    bindPort: port,
    publicUrl,
    certPath: media.certPath,
    keyPath: media.keyPath,
  };
}

/** A TLS server that answers nothing but WebSocket upgrades. */
export function createDirectSocketServer(config: DirectSocketConfig): HttpsServer {
  return createServer({
    cert: readFileSync(config.certPath),
    key: readFileSync(config.keyPath),
  }, (_request, response) => {
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end();
  });
}
