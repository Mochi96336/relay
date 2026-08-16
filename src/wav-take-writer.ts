import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const WAV_HEADER_BYTES = 44;
const MAX_WAV_DATA_BYTES = 0xffff_ffff - 36;

export type WavFileArtifact = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  sampleCount: number;
  durationMs: number;
};

export function encodePcm16WavHeader(sampleRate: number, dataBytes: number) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('Invalid WAV sample rate.');
  if (!Number.isInteger(dataBytes) || dataBytes < 0 || dataBytes > MAX_WAV_DATA_BYTES || dataBytes % 2 !== 0) {
    throw new Error('Invalid WAV PCM payload length.');
  }

  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Streams the already-authoritative server mix directly to disk.
 *
 * The file stays as `.wav.part` while recording. Only finalization patches the
 * RIFF sizes and renames it to `.wav`, so an interrupted writer can never be
 * mistaken for a ready Take artifact.
 */
export class WavTakeWriter {
  readonly takeId: string;
  readonly sampleRate: number;
  readonly fileName: string;
  readonly filePath: string;

  private readonly partPath: string;
  private readonly stream: WriteStream;
  private dataBytes = 0;
  private closed = false;
  private failure: Error | null = null;

  constructor(options: {
    directory: string;
    takeId: string;
    sampleRate: number;
    onError?: (error: Error) => void;
  }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.takeId)) throw new Error('Invalid Take ID.');
    if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) throw new Error('Invalid Take sample rate.');

    mkdirSync(options.directory, { recursive: true });
    this.takeId = options.takeId;
    this.sampleRate = options.sampleRate;
    this.fileName = `${options.takeId}.wav`;
    this.filePath = path.join(options.directory, this.fileName);
    this.partPath = `${this.filePath}.part`;
    this.stream = createWriteStream(this.partPath, { flags: 'wx' });
    this.stream.on('error', (error) => {
      if (this.failure) return;
      this.failure = error;
      options.onError?.(error);
    });
    this.stream.write(encodePcm16WavHeader(this.sampleRate, 0));
  }

  get sampleCount() {
    return this.dataBytes / 2;
  }

  append(frame: Buffer) {
    if (this.closed) throw new Error('Take WAV writer is closed.');
    if (this.failure) throw this.failure;
    if (frame.byteLength % 2 !== 0) throw new Error('Take PCM frame is not 16-bit aligned.');
    if (this.dataBytes + frame.byteLength > MAX_WAV_DATA_BYTES) {
      throw new Error('Take exceeded the WAV RIFF size limit.');
    }

    this.dataBytes += frame.byteLength;
    this.stream.write(frame);
  }

  async finalize(): Promise<WavFileArtifact> {
    if (this.closed) throw new Error('Take WAV writer is already closed.');
    this.closed = true;

    await new Promise<void>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      const onError = (error: Error) => reject(error);
      this.stream.once('error', onError);
      this.stream.once('finish', () => {
        this.stream.off('error', onError);
        resolve();
      });
      this.stream.end();
    });

    if (this.failure) throw this.failure;
    const handle = await open(this.partPath, 'r+');
    try {
      const header = encodePcm16WavHeader(this.sampleRate, this.dataBytes);
      await handle.write(header, 0, header.byteLength, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(this.partPath, this.filePath);
    const info = await stat(this.filePath);
    return {
      fileName: this.fileName,
      filePath: this.filePath,
      sizeBytes: info.size,
      sampleRate: this.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      sampleCount: this.sampleCount,
      durationMs: (this.sampleCount / this.sampleRate) * 1000,
    };
  }

  async abort() {
    if (!this.closed) {
      this.closed = true;
      this.stream.destroy();
    }
    await rm(this.partPath, { force: true }).catch(() => {});
  }
}
