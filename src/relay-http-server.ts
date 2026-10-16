import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

import express from 'express';

const TAKE_ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RelayHttpReadiness = {
  ready: boolean;
};

export type RelayHttpServerOptions = {
  publicDir: string;
  /** The page build (relay-build.ts) written into the served index.html, read per request. */
  build: string | (() => string);
  takeDir: string;
  relayKey: string | null;
  remoteStatus: () => unknown;
  observationStatusV1: () => unknown;
  readiness: () => RelayHttpReadiness;
  micOpusTrial?: boolean;
  /** Where a Mic may open its socket without the tunnel (direct-socket.ts), read per request. */
  directSocketUrl?: () => string | null;
};

/**
 * Owns Relay's physical HTTP surface only. The caller remains authoritative
 * for remote status, observation status and readiness semantics; this adapter
 * evaluates those callbacks lazily for each request.
 */
export function createRelayHttpServer(options: RelayHttpServerOptions): Server {
  const app = express();
  app.disable('x-powered-by');
  app.get('/mic-codec-config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ opus: options.micOpusTrial === true, bitrate: 128_000 });
  });
  app.get('/mic-opus.wasm', (_req, res) => {
    res.type('application/wasm');
    res.sendFile(path.resolve(options.publicDir, '../node_modules/@evan/opus/wasm/opus.wasm'));
  });

  app.get('/takes/:takeId.wav', (req, res) => {
    if (options.relayKey && req.query.key !== options.relayKey) {
      res.sendStatus(401);
      return;
    }
    const takeId = String(req.params.takeId ?? '');
    if (!TAKE_ARTIFACT_ID_PATTERN.test(takeId)) {
      res.sendStatus(404);
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('audio/wav');
    res.sendFile(path.join(options.takeDir, takeId + '.wav'));
  });

  // Browser and server policy can share pure modules without making src depend
  // on browser-static public/. The production public directory is always the
  // repository's public/ directory, so the shared layer is its explicit sibling.
  // The page carries the build it was served with, so a page left open across
  // a Relay update can tell it is out of date (#487). Ahead of express.static,
  // which would otherwise serve index.html for `/` unchanged.
  app.get(['/', '/index.html'], async (_req, res, next) => {
    try {
      const html = await readFile(path.join(options.publicDir, 'index.html'), 'utf8');
      res.setHeader('Cache-Control', 'no-cache');
      const build = typeof options.build === 'function' ? options.build() : options.build;
      const directSocketUrl = options.directSocketUrl?.() ?? null;
      const meta = [`<meta name="relay-build" content="${build}" />`];
      if (directSocketUrl) meta.push(`<meta name="relay-direct-socket" content="${escapeAttribute(directSocketUrl)}" />`);
      res.type('html').send(html.replace('<head>', `<head>\n    ${meta.join('\n    ')}`));
    } catch (error) {
      next(error);
    }
  });
  app.use('/shared', express.static(path.resolve(options.publicDir, '../shared')));
  app.use(express.static(options.publicDir));
  // Live status must never be served from a cache. Behind Cloudflare a
  // response without Cache-Control can be held at the edge, and the System
  // panel then showed a Mic that had long since connected as absent.
  const noStore: express.RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  app.get('/healthz', noStore, (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/statusz', noStore, (_req, res) => {
    res.json(options.remoteStatus());
  });
  app.get('/api/status/v1', noStore, (_req, res) => {
    res.json(options.observationStatusV1());
  });
  app.get('/readyz', noStore, (_req, res) => {
    const readiness = options.readiness();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  return createServer(app);
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
