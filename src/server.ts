import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const port = Number(process.env.PORT ?? 3000);
const relayKey = process.env.RELAY_KEY ?? null;

const app = express();
app.disable('x-powered-by');
app.use(express.static(publicDir));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  if (relayKey && url.searchParams.get('key') !== relayKey) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit('connection', webSocket, request);
  });
});

type ClientRole = 'publisher' | 'monitor' | 'unknown';
type RelaySocket = WebSocket & {
  role: ClientRole;
  sampleRate?: number;
  isAlive: boolean;
};

let publisher: RelaySocket | null = null;
let publisherSampleRate: number | null = null;

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcastToMonitors(payload: string | Buffer, binary = false) {
  for (const client of wss.clients) {
    const socket = client as RelaySocket;
    if (socket.role !== 'monitor' || socket.readyState !== WebSocket.OPEN) continue;
    if (binary && socket.bufferedAmount > 512 * 1024) continue;
    socket.send(payload, { binary });
  }
}

function broadcastStatus() {
  broadcastToMonitors(
    JSON.stringify({
      type: 'publisher-status',
      connected: publisher?.readyState === WebSocket.OPEN,
      sampleRate: publisherSampleRate,
    }),
  );
}

wss.on('connection', (rawSocket) => {
  const socket = rawSocket as RelaySocket;
  socket.role = 'unknown';
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      if (socket !== publisher || socket.role !== 'publisher') return;
      broadcastToMonitors(data as Buffer, true);
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendJson(socket, { type: 'error', message: 'Invalid JSON message.' });
      return;
    }

    if (!message || typeof message !== 'object') return;
    const payload = message as Record<string, unknown>;

    if (payload.type === 'register' && payload.role === 'publisher') {
      if (publisher && publisher !== socket && publisher.readyState === WebSocket.OPEN) {
        sendJson(socket, { type: 'error', message: 'A publisher is already connected.' });
        return;
      }

      const sampleRate = Number(payload.sampleRate);
      if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
        sendJson(socket, { type: 'error', message: 'Invalid sample rate.' });
        return;
      }

      socket.role = 'publisher';
      socket.sampleRate = sampleRate;
      publisher = socket;
      publisherSampleRate = sampleRate;
      sendJson(socket, { type: 'registered', role: 'publisher' });
      broadcastStatus();
      return;
    }

    if (payload.type === 'register' && payload.role === 'monitor') {
      socket.role = 'monitor';
      sendJson(socket, { type: 'registered', role: 'monitor' });
      sendJson(socket, {
        type: 'publisher-status',
        connected: publisher?.readyState === WebSocket.OPEN,
        sampleRate: publisherSampleRate,
      });
      return;
    }
  });

  socket.on('close', () => {
    if (socket === publisher) {
      publisher = null;
      publisherSampleRate = null;
      broadcastStatus();
    }
  });
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const socket = client as RelaySocket;
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(port, '0.0.0.0', () => {
  console.log(`Relay listening on http://localhost:${port}`);
  console.log('For a phone, expose this HTTP server through an HTTPS tunnel before using the microphone.');
});
