import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const transportModuleUrl = new URL('../public/audio-transport.js', import.meta.url);

class ImmediateWriter {
  desiredSize = 1;
  writes: Uint8Array[] = [];
  released = false;

  async write(value: Uint8Array) {
    this.writes.push(new Uint8Array(value));
  }

  releaseLock() {
    this.released = true;
  }
}

class DeferredRejectWriter {
  desiredSize = 1;
  writes: Uint8Array[] = [];
  released = false;
  private rejectPending: ((error: Error) => void) | null = null;

  write(value: Uint8Array) {
    this.writes.push(new Uint8Array(value));
    return new Promise<void>((_resolve, reject) => {
      this.rejectPending = reject;
    });
  }

  fail() {
    this.rejectPending?.(new Error('stale datagram failed'));
    this.rejectPending = null;
  }

  releaseLock() {
    this.released = true;
  }
}

class ReplacingWebTransport {
  static instances: ReplacingWebTransport[] = [];
  readonly ready = Promise.resolve();
  readonly closed: Promise<void>;
  readonly writer: ImmediateWriter | DeferredRejectWriter;
  readonly datagrams: {
    maxDatagramSize: number;
    writable: { getWriter: () => ImmediateWriter | DeferredRejectWriter };
  };
  private resolveClosed!: () => void;

  constructor(readonly url: string) {
    this.writer = url.includes('old') ? new DeferredRejectWriter() : new ImmediateWriter();
    this.datagrams = {
      maxDatagramSize: 1200,
      writable: { getWriter: () => this.writer },
    };
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    ReplacingWebTransport.instances.push(this);
  }

  close() {
    this.resolveClosed();
  }
}

describe('late transition completions', () => {
  test('a stale WebTransport write rejection cannot demote its replacement', async () => {
    ReplacingWebTransport.instances.length = 0;
    const { PreferredAudioTransport } = await import(transportModuleUrl.href);
    const transport = new PreferredAudioTransport({ WebTransportClass: ReplacingWebTransport });

    assert.equal(await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test/media?ticket=old',
    }), true);
    const oldTransport = ReplacingWebTransport.instances.at(-1)!;
    const oldWriter = oldTransport.writer;
    assert.ok(oldWriter instanceof DeferredRejectWriter);
    assert.equal(transport.send(new Uint8Array([1]).buffer).path, 'webtransport');

    assert.equal(await transport.prefer({
      preferred: 'webtransport',
      url: 'https://media.example.test/media?ticket=new',
    }), true);
    const replacement = ReplacingWebTransport.instances.at(-1)!;
    assert.notEqual(replacement, oldTransport);

    oldWriter.fail();
    await Promise.resolve();
    await Promise.resolve();

    const stats = transport.stats();
    assert.equal(stats.path, 'webtransport');
    assert.equal(stats.webTransportSendFailures, 0);
    assert.equal(transport.send(new Uint8Array([2]).buffer).path, 'webtransport');
    await Promise.resolve();
    assert.deepEqual(replacement.writer.writes.map((value) => Array.from(value)), [[2]]);
  });

  test('Take history feedback guard includes sibling tabs owned by the same participant', async () => {
    const source = await readFile(new URL('../public/take-history.js', import.meta.url), 'utf8');

    assert.match(source, /let roomMicActive = false/);
    assert.match(source, /function phoneOwnsMic\(\)[\s\S]*return localMicActive \|\| roomMicActive/);
    assert.match(source, /window\.addEventListener\('relay-session-status'/);
    assert.match(source, /ownerId === participantId/);
    assert.match(source, /window\.dispatchEvent\(new Event\('relay-request-session-status'\)\)/);
    assert.match(source, /roomMicActive = nextRoomMicActive[\s\S]*reconcileMicFeedbackGuard\(\)/);
  });
});
