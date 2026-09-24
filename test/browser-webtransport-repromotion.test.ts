import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(payload: unknown) {
    this.sent.push(payload);
  }
}

class ClosableWebTransport {
  static instances: ClosableWebTransport[] = [];
  static failNext = 0;
  readonly writes: Uint8Array[] = [];
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  readonly datagrams = {
    maxDatagramSize: 1200,
    writable: {
      getWriter: () => ({
        write: async (value: Uint8Array) => {
          this.writes.push(new Uint8Array(value));
        },
        releaseLock() {},
      }),
    },
  };

  constructor(readonly url: string) {
    ClosableWebTransport.instances.push(this);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    if (ClosableWebTransport.failNext > 0) {
      ClosableWebTransport.failNext -= 1;
      this.ready = Promise.reject(new Error('handshake failed'));
      this.ready.catch(() => {});
    } else {
      this.ready = Promise.resolve();
    }
  }

  /** The network under the session went away (Wi-Fi to cellular, NAT rebinding). */
  drop() {
    this.resolveClosed();
  }

  close() {
    this.resolveClosed();
  }
}

function manualTimers() {
  const pending: { callback: () => void; delayMs: number; cancelled: boolean }[] = [];
  return {
    pending,
    setTimer: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cancelled: false };
      pending.push(timer);
      return timer;
    },
    clearTimer: (timer: { cancelled: boolean }) => {
      timer.cancelled = true;
    },
    fireNext() {
      const timer = pending.shift();
      assert.ok(timer, 'a retry is scheduled');
      if (!timer.cancelled) timer.callback();
      return timer.delayMs;
    },
  };
}

const offer = {
  preferred: 'webtransport',
  url: 'https://media.example.test:4433/media?ticket=roam',
};

const settle = async () => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
};

async function connected() {
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  ClosableWebTransport.instances.length = 0;
  ClosableWebTransport.failNext = 0;
  const timers = manualTimers();
  const transport = new PreferredAudioTransport({
    minimumPacketBytes: 26,
    WebTransportClass: ClosableWebTransport,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const socket = new FakeSocket();
  transport.bind(socket);
  assert.equal(await transport.prefer(offer), true);
  return { transport, socket, timers };
}

describe('WebTransport re-promotion after a transport-level demotion', () => {
  it('returns the capture to datagrams after the session drops', async () => {
    const { transport, timers } = await connected();
    ClosableWebTransport.instances[0]!.drop();
    await settle();
    assert.equal(transport.stats().path, 'websocket', 'media continues on the fallback meanwhile');

    assert.equal(timers.fireNext(), 2_000);
    await settle();
    assert.equal(transport.stats().path, 'webtransport');
    assert.equal(ClosableWebTransport.instances.length, 2);
    assert.equal(ClosableWebTransport.instances[1]!.url, offer.url, 'the same capture-scoped offer');
    assert.equal(transport.stats().webTransportRetries, 1);
  });

  it('backs off between failed retries and stops at the longest delay', async () => {
    const { transport, timers } = await connected();
    ClosableWebTransport.failNext = 10;
    ClosableWebTransport.instances[0]!.drop();
    await settle();

    const delays = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      delays.push(timers.fireNext());
      await settle();
    }
    assert.deepEqual(delays, [2_000, 5_000, 15_000, 30_000, 30_000]);
    assert.equal(transport.stats().path, 'websocket');
  });

  it('never retries a path media recovery quarantined', async () => {
    const { transport, timers } = await connected();
    transport.mediaPathRecovery.webTransportQuarantined = true;
    ClosableWebTransport.instances[0]!.drop();
    await settle();
    assert.equal(timers.pending.length, 0);
  });

  it('forgets the retry when the capture closes', async () => {
    const { transport, timers } = await connected();
    ClosableWebTransport.instances[0]!.drop();
    await settle();
    transport.close();
    timers.fireNext();
    await settle();
    assert.equal(ClosableWebTransport.instances.length, 1, 'a closed capture never reconnects');
  });
});
