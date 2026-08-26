import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

import {
  ListenerIncidentStore,
  parseListenerIncidentReport,
} from './listener-incident-store.js';

const INCIDENT_PATH = '/api/debug/listener-incidents';
const MAX_BODY_BYTES = 256 * 1024;

class PayloadTooLargeError extends Error {}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = `${JSON.stringify(payload)}\n`;
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new PayloadTooLargeError('Listener incident body is too large.');
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(body);
}

export function installListenerIncidentDebugEndpoint() {
  if (process.env.RELAY_LISTENER_INCIDENTS !== '1') return () => {};

  const directory = path.resolve(
    process.env.RELAY_LISTENER_INCIDENT_DIR ?? path.join(process.cwd(), 'listener-incidents'),
  );
  const store = new ListenerIncidentStore(
    directory,
    positiveInt(process.env.RELAY_LISTENER_INCIDENT_MAX_FILES, 100),
  );
  const relayKey = process.env.RELAY_KEY ?? null;

  const originalCreateServer = http.createServer;
  let wrappedServer = false;

  http.createServer = ((...args: unknown[]) => {
    if (!wrappedServer) {
      const listenerIndex = typeof args[0] === 'function'
        ? 0
        : typeof args[1] === 'function'
          ? 1
          : -1;
      if (listenerIndex >= 0) {
        const downstream = args[listenerIndex] as (
          req: IncomingMessage,
          res: ServerResponse,
        ) => void;
        args[listenerIndex] = (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          if (url.pathname !== INCIDENT_PATH) {
            downstream(req, res);
            return;
          }

          if (url.searchParams.get('audioDebug') !== '1') {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          if (relayKey && url.searchParams.get('key') !== relayKey) {
            res.statusCode = 401;
            res.end('Unauthorized');
            return;
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end('Method Not Allowed');
            return;
          }
          const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
          if (contentType !== 'application/json') {
            sendJson(res, 415, { ok: false, error: 'json-required' });
            return;
          }

          void (async () => {
            try {
              const body = await readJsonBody(req);
              const report = parseListenerIncidentReport(body);
              if (!report) {
                sendJson(res, 400, { ok: false, error: 'invalid-listener-incident' });
                return;
              }
              const stored = await store.write(report);
              console.log(`[listener-incident] stored ${stored.incidentId}`);
              sendJson(res, 201, { ok: true, incidentId: stored.incidentId });
            } catch (error) {
              if (error instanceof PayloadTooLargeError) {
                sendJson(res, 413, { ok: false, error: 'listener-incident-too-large' });
                return;
              }
              if (error instanceof SyntaxError) {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
              }
              console.error('[listener-incident] failed to persist report', error);
              sendJson(res, 500, { ok: false, error: 'listener-incident-write-failed' });
            }
          })();
        };
        wrappedServer = true;
      }
    }
    return Reflect.apply(originalCreateServer, http, args);
  }) as typeof http.createServer;
  syncBuiltinESMExports();

  return () => {
    http.createServer = originalCreateServer;
    syncBuiltinESMExports();
  };
}
