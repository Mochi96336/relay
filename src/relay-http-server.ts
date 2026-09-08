import { createServer, type Server } from 'node:http';
import path from 'node:path';

import express from 'express';

import { ListenerIncidentStore, parseListenerIncidentReport } from './listener-incident-store.js';

const TAKE_ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LISTENER_INCIDENT_PATH = '/api/debug/listener-incidents';
const LISTENER_INCIDENT_MAX_BODY_BYTES = 512 * 1024;

class ListenerIncidentPayloadTooLargeError extends Error {}

async function readListenerIncidentJson(req: express.Request) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > LISTENER_INCIDENT_MAX_BODY_BYTES) {
      throw new ListenerIncidentPayloadTooLargeError('Listener incident body is too large.');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export type RelayHttpReadiness = {
  ready: boolean;
};

export type RelayHttpServerOptions = {
  publicDir: string;
  takeDir: string;
  relayKey: string | null;
  remoteStatus: () => unknown;
  observationStatusV1: () => unknown;
  readiness: () => RelayHttpReadiness;
  listenerIncidents?: {
    directory: string;
    maxFiles: number;
  } | null;
};

/**
 * Owns Relay's physical HTTP surface only. The caller remains authoritative
 * for remote status, observation status and readiness semantics; this adapter
 * evaluates those callbacks lazily for each request.
 */
export function createRelayHttpServer(options: RelayHttpServerOptions): Server {
  const app = express();
  app.disable('x-powered-by');

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

  const listenerIncidentStore = options.listenerIncidents
    ? new ListenerIncidentStore(
      options.listenerIncidents.directory,
      options.listenerIncidents.maxFiles,
    )
    : null;

  if (listenerIncidentStore) {
    app.all(LISTENER_INCIDENT_PATH, async (req, res) => {
      if (req.query.audioDebug !== '1') {
        res.sendStatus(404);
        return;
      }
      if (options.relayKey && req.query.key !== options.relayKey) {
        res.sendStatus(401);
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        res.sendStatus(405);
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        res.status(415).json({ ok: false, error: 'json-required' });
        return;
      }

      try {
        const report = parseListenerIncidentReport(await readListenerIncidentJson(req));
        if (!report) {
          res.status(400).json({ ok: false, error: 'invalid-listener-incident' });
          return;
        }
        const stored = await listenerIncidentStore.write(report);
        console.log(`[listener-incident] stored ${stored.incidentId}`);
        res.status(201).json({ ok: true, incidentId: stored.incidentId });
      } catch (error) {
        if (error instanceof ListenerIncidentPayloadTooLargeError) {
          res.status(413).json({ ok: false, error: 'listener-incident-too-large' });
          return;
        }
        if (error instanceof SyntaxError) {
          res.status(400).json({ ok: false, error: 'invalid-json' });
          return;
        }
        console.error('[listener-incident] failed to persist report', error);
        res.status(500).json({ ok: false, error: 'listener-incident-write-failed' });
      }
    });
  }

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
