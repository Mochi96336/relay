import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class BrowserSocket {
  readyState = 1;
  bufferedAmount = 0;
  send(_payload: unknown) {}
  close() {}
  addEventListener(_type: string, _listener: (event: { data: string }) => void) {}
  removeEventListener(_type: string, _listener: (event: { data: string }) => void) {}
}

class DeferredWriter {
  readonly pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  released = false;

  write(_payload: Uint8Array) {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  rejectOne() {
    this.pending.shift()?.reject(new Error('retired capture write failed'));
  }

  releaseLock() {
    this.released = true;
  }
}

class DeferredWebTransport {
  static instances: DeferredWebTransport[] = [];

  readonly ready = Promise.resolve();
  readonly writer = new DeferredWriter();
  readonly datagrams = {
    maxDatagramSize: 1_200,
    writable: { getWriter: () => this.writer },
    outgoingHighWaterMark: 1,
  };
  readonly closed = new Promise<void>(() => {});
  closeCalls = 0;

  constructor(_url: string, _options?: unknown) {
    DeferredWebTransport.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
  }
}

async function transport(nowMs: () => number) {
  DeferredWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const value = new PreferredAudioTransport({
    WebTransportClass: DeferredWebTransport,
    datagramWriteTimeoutMs: 1_000,
    nowMs,
  });
  value.bind(new BrowserSocket());
  assert.equal(await value.prefer({
    preferred: 'webtransport',
    url: 'https://relay.test/capture-generation-write-fence',
  }), true);
  return value;
}

test('capture-generation reset retires old unresolved WT write from the stall watchdog', async () => {
  let nowMs = 0;
  const value = await transport(() => nowMs);

  assert.equal(value.send(new Uint8Array(100)).sent, true);
  assert.equal(value.stats().webTransportPacketsSubmitted, 1);
  assert.equal(value.stats().path, 'webtransport');

  // app.js calls resetStats() exactly when captureGeneration advances. The
  // unresolved write belongs to the retired capture and cannot remain #287
  // stall evidence for its replacement generation.
  value.resetStats();
  nowMs = 2_000;

  assert.equal(value.state().path, 'webtransport');
  assert.equal(value.stats().webTransportDemotions, 0);
  assert.equal(value.stats().webTransportSendFailures, 0);

  value.close();
});

test('late rejection from the retired capture cannot contaminate replacement telemetry or demote reused WT', async () => {
  const value = await transport(() => 0);
  assert.equal(value.send(new Uint8Array(100)).sent, true);
  const oldWriter = DeferredWebTransport.instances[0].writer;

  value.resetStats();
  assert.equal(value.stats().webTransportPacketsSubmitted, 0);
  assert.equal(value.stats().webTransportSendFailures, 0);
  assert.equal(value.stats().webTransportDemotions, 0);

  // The replacement capture intentionally reuses the healthy physical WT
  // session. Its new write belongs to the new logical write epoch even though
  // the writer object itself is unchanged.
  assert.equal(value.send(new Uint8Array(100)).sent, true);
  assert.equal(value.stats().webTransportPacketsSubmitted, 1);

  oldWriter.rejectOne();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(value.stats().webTransportSendFailures, 0,
    'retired-generation async failure must not enter the replacement capture counters');
  assert.equal(value.stats().webTransportDemotions, 0,
    'retired-generation async failure must not spend the replacement capture media path');
  assert.equal(value.stats().path, 'webtransport');
  assert.equal(DeferredWebTransport.instances[0].closeCalls, 0,
    'capture boundary must not tear down the healthy physical WT session');

  value.close();
});
