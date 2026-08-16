import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../../src/audio-packet.js';
import { encodePcmFrame } from '../../src/pcm-frame.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STARTUP_TIMEOUT_MS = 20_000;

export type RelayServer = {
  port: number;
  wsUrl: (query?: string) => string;
  httpUrl: (pathname?: string) => string;
  stop: () => Promise<void>;
};

/**
 * Runs the real server as a child process on an OS-assigned port. Timings that
 * would otherwise dominate a test run are shortened through the RELAY_* knobs.
 */
export function startRelay(env: Record<string, string> = {}): Promise<RelayServer> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(root, 'src', 'server-entry.ts')],
    {
      cwd: root,
      env: { ...process.env, PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  return new Promise<RelayServer>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Relay did not start within ${STARTUP_TIMEOUT_MS} ms.\n${stdout}\n${stderr}`));
    }, STARTUP_TIMEOUT_MS);

    const stop = () => new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      child.once('exit', () => done());
      child.kill();
    });

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited early with code ${code}.\n${stdout}\n${stderr}`));
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/localhost:(\d+)/);
      if (!match) return;

      clearTimeout(timer);
      child.removeAllListeners('exit');
      const port = Number(match[1]);
      resolve({
        port,
        wsUrl: (query = '') => `ws://127.0.0.1:${port}/ws${query}`,
        httpUrl: (pathname = '/') => `http://127.0.0.1:${port}${pathname}`,
        stop,
      });
    });
  });
}

type JsonMessage = Record<string, any>;

export class RelayClient {
  readonly messages: JsonMessage[] = [];
  readonly errors: string[] = [];
  binaryFrames = 0;
  binarySamples = 0;
  private generation = 1;
  private sampleCursor = 0;
  private packetSequence = 0;
  private readonly waiters: { predicate: (m: JsonMessage) => boolean; resolve: (m: JsonMessage) => void }[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.binaryFrames += 1;
        this.binarySamples += data.byteLength / 2;
        return;
      }

      let message: JsonMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      this.messages.push(message);
      if (message.type === 'error') this.errors.push(String(message.message));

      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        if (this.waiters[i].predicate(message)) {
          this.waiters.splice(i, 1)[0].resolve(message);
        }
      }
    });
  }

  static connect(server: RelayServer, query = ''): Promise<RelayClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(server.wsUrl(query));
      const client = new RelayClient(socket);
      socket.once('open', () => resolve(client));
      socket.once('error', reject);
    });
  }

  send(payload: unknown) {
    this.socket.send(JSON.stringify(payload));
  }

  /** Frames PCM the way a real capture does, advancing the sample cursor. */
  sendPcm(buffer: Buffer) {
    const index = this.sampleCursor;
    this.sampleCursor += buffer.byteLength / 2;
    this.socket.send(encodePcmFrame(this.generation, index, buffer), { binary: true });
  }

  /** AudioPacket v2, used by the phone media path. */
  sendAudioPacket(buffer: Buffer) {
    const index = this.sampleCursor;
    const sequence = this.packetSequence;
    this.sampleCursor += buffer.byteLength / 2;
    this.packetSequence = (this.packetSequence + 1) >>> 0;
    this.sendBinary(encodeAudioPacket({
      source: 'mic',
      generation: this.generation,
      sequence,
      firstSampleIndex: index,
      pcm: buffer,
    }));
  }

  /** Sends an already-framed binary packet without mutating capture state. */
  sendBinary(buffer: Buffer) {
    this.socket.send(buffer, { binary: true });
  }

  /** Captured but never sent: what a congested uplink does. */
  skipPcm(buffer: Buffer) {
    this.sampleCursor += buffer.byteLength / 2;
  }

  /** A pre-framing client, to check the server still copes with one. */
  sendUnheaderedPcm(buffer: Buffer) {
    this.socket.send(buffer, { binary: true });
  }

  /** A new capture session, as if the user restarted the microphone. */
  newCaptureSession() {
    this.generation += 1;
    this.sampleCursor = 0;
    this.packetSequence = 0;
  }

  get cursor() {
    return this.sampleCursor;
  }

  get generationId() {
    return this.generation;
  }

  /** Same capture, new socket: what app.js does when only the websocket died. */
  resumeCaptureSession(generation: number, sampleCursor: number, packetSequence = 0) {
    this.generation = generation;
    this.sampleCursor = sampleCursor;
    this.packetSequence = packetSequence >>> 0;
  }

  get packetSequenceId() {
    return this.packetSequence;
  }

  /** Resolves on the first matching message, including ones already received. */
  waitFor(predicate: (message: JsonMessage) => boolean, timeoutMs = 5_000): Promise<JsonMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonMessage) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out after ${timeoutMs} ms. Saw: ${this.messages.map((m) => m.type).join(', ')}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForType(type: string, timeoutMs?: number) {
    return this.waitFor((message) => message.type === type, timeoutMs);
  }

  latest(type: string): JsonMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].type === type) return this.messages[i];
    }
    return undefined;
  }

  close() {
    this.socket.close();
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Deterministic PRNG so a failing calibration assertion is reproducible. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Percussive pulses at irregular intervals. The timing analyser matches short-term
 * energy envelopes, so it needs clear attacks, and irregular spacing keeps a
 * repeated beat from producing an ambiguous correlation peak.
 */
export function pulseTrain(samples: number, sampleRate: number, seed = 7) {
  const random = lcg(seed);
  const output = new Float64Array(samples);
  let cursor = Math.round(sampleRate * 0.05);

  while (cursor < samples) {
    const frequency = 200 + random() * 700;
    const amplitude = 0.35 + random() * 0.45;
    const decay = 25 + random() * 30;
    const length = Math.min(samples - cursor, Math.round(sampleRate * 0.18));

    for (let i = 0; i < length; i += 1) {
      const seconds = i / sampleRate;
      output[cursor + i] += Math.sin(2 * Math.PI * frequency * seconds) * amplitude * Math.exp(-seconds * decay);
    }

    cursor += Math.round(sampleRate * (0.08 + random() * 0.18));
  }

  return output;
}

/**
 * Percussive pulses at a *regular* interval, standing in for a musical beat.
 * Unlike `pulseTrain`, shifting this by the period leaves it looking almost
 * identical to itself - which is exactly the ambiguity a real song's beat
 * grid creates for the analyser.
 */
export function beatTrain(samples: number, sampleRate: number, periodMs: number, seed = 7) {
  const random = lcg(seed);
  const output = new Float64Array(samples);
  const periodSamples = Math.round((sampleRate * periodMs) / 1000);
  let cursor = Math.round(sampleRate * 0.05);

  while (cursor < samples) {
    const amplitude = 0.7 + random() * 0.2;
    const length = Math.min(samples - cursor, Math.round(sampleRate * 0.12));

    for (let i = 0; i < length; i += 1) {
      const seconds = i / sampleRate;
      output[cursor + i] += Math.sin(2 * Math.PI * 90 * seconds) * amplitude * Math.exp(-seconds * 40);
    }

    cursor += periodSamples;
  }

  return output;
}

export function toInt16(values: Float64Array, gain = 1, noise = 0, seed = 11) {
  const random = lcg(seed);
  const output = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i += 1) {
    const noisy = values[i] * gain + (noise > 0 ? (random() - 0.5) * 2 * noise : 0);
    const clamped = Math.max(-1, Math.min(1, noisy));
    output.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
  }
  return output;
}

/**
 * Builds a microphone/backing pair where the same events land `lagMs` later in
 * the microphone stream, which is the sign convention the server uses.
 */
export function laggedPair(seconds: number, sampleRate: number, lagMs: number, seed = 7) {
  const samples = Math.round(sampleRate * seconds);
  const lagSamples = Math.round((Math.abs(lagMs) * sampleRate) / 1000);
  const master = pulseTrain(samples + lagSamples, sampleRate, seed);

  const micStart = lagMs >= 0 ? 0 : lagSamples;
  const backingStart = lagMs >= 0 ? lagSamples : 0;

  return {
    mic: toInt16(master.subarray(micStart, micStart + samples), 0.45, 0.004),
    backing: toInt16(master.subarray(backingStart, backingStart + samples), 0.9),
  };
}

/**
 * Same shape as `laggedPair`, but built from a regular beat instead of
 * irregular pulses, with vocal-like broadband noise riding on top of the mic
 * side. A song is never *just* its beat grid; the noise is what a real match
 * has to key on that a beat-multiple alias does not share.
 */
export function laggedBeatPair(
  seconds: number,
  sampleRate: number,
  lagMs: number,
  periodMs: number,
  seed = 7,
) {
  const samples = Math.round(sampleRate * seconds);
  const lagSamples = Math.round((Math.abs(lagMs) * sampleRate) / 1000);
  const master = beatTrain(samples + lagSamples, sampleRate, periodMs, seed);

  const micStart = lagMs >= 0 ? 0 : lagSamples;
  const backingStart = lagMs >= 0 ? lagSamples : 0;

  const micBeat = master.subarray(micStart, micStart + samples);
  const random = lcg(seed + 1);
  const micWithVoice = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    micWithVoice[i] = micBeat[i] + (random() - 0.5) * 0.15;
  }

  return {
    mic: toInt16(micWithVoice, 0.45, 0.004),
    backing: toInt16(master.subarray(backingStart, backingStart + samples), 0.9),
  };
}

export async function sendPcmInChunks(client: RelayClient, pcm: Buffer, frameSamples = 960) {
  const frameBytes = frameSamples * 2;
  for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
    client.sendPcm(pcm.subarray(offset, Math.min(pcm.byteLength, offset + frameBytes)));
    // Yield so the socket drains instead of building a multi-megabyte backlog.
    if ((offset / frameBytes) % 50 === 0) await sleep(0);
  }
}
