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
  /** The page build (relay-build.ts) written into the served index.html. */
  build: string;
  takeDir: string;
  relayKey: string | null;
  remoteStatus: () => unknown;
  observationStatusV1: () => unknown;
  readiness: () => RelayHttpReadiness;
  micOpusTrial?: boolean;
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
      res.type('html').send(html.replace(
        '<head>',
        `<head>\n    <meta name="relay-build" content="${options.build}" />`,
      ));
    } catch (error) {
      next(error);
    }
  });
  app.use('/shared', express.static(path.resolve(options.publicDir, '../shared')));
  app.use(express.static(options.publicDir));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/statusz', (_req, res) => {
    res.json(options.remoteStatus());
  });
  app.get('/api/status/v1', (_req, res) => {
    res.json(options.observationStatusV1());
  });
  app.get('/readyz', (_req, res) => {
    const readiness = options.readiness();
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  return createServer(app);
}
