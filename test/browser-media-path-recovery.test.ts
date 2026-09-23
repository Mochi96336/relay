import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);

class EventSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();

  send(payload: unknown) {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emitJson(payload: unknown) {
    const event = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }
}

class FakeDatagramWriter {
  released = false;
  writes: Uint8Array[] = [];

  async write(value: Uint8Array) {
    this.writes.push(new Uint8Array(value));
  }

  releaseLock() {
    this.released = true;
  }
}

class FakeWebTransport {
  static instances: FakeWebTransport[] = [];
  readonly writer = new FakeDatagramWriter();
  readonly ready = Promise.resolve();
  readonly datagrams = {
    maxDatagramSize: 1_200,
    writable: { getWriter: () => this.writer },
  };
  readonly closed: Promise<void>;
  closeCalls = 0;
  private resolveClosed!: () => void;

  constructor(readonly url: string) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    FakeWebTransport.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
    this.resolveClosed();
  }
}

function health(captureGeneration: number, capturedSamples: number) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration,
    capturedSamples,
  };
}

function ack(
  captureGeneration: number,
  acceptedFrameSerial: number,
  mediaPath: 'webtransport' | 'websocket' | null,
) {
  return {
    type: 'audio-uplink-health-ack',
    version: 1,
    captureGeneration,
    pcm: { acceptedFrameSerial, mediaPath },
  };
}

test('server-stale accepted PCM demotes WT once and quarantines it for the capture generation', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);

  assert.equal(await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' }), true);
  assert.equal(transport.stats().path, 'webtransport');
  assert.equal(FakeWebTransport.instances.length, 1);

  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300]) {
    assert.equal(transport.sendControlJson(health(7, capturedSamples)).sent, true);
    socket.emitJson(ack(7, 10, 'webtransport'));
  }

  assert.equal(transport.stats().path, 'websocket');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 1);

  // A same-generation control reconnect can advertise the same WT ticket, but
  // semantic failure quarantines WT until the capture generation changes.
  assert.equal(await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' }), false);
  assert.equal(FakeWebTransport.instances.length, 1);
  assert.equal(transport.stats().path, 'websocket');

  // app.js calls resetStats() only when it advances the capture generation.
  transport.resetStats();
  assert.equal(await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media-next' }), true);
  assert.equal(FakeWebTransport.instances.length, 2);
});

test('delayed ordered health ACKs preserve per-report local frontiers when detecting stale server PCM', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' });

  // Model several health reports already in flight before their ordered
  // WebSocket ACKs drain. Each report has a distinct local capture frontier,
  // and the control socket preserves request/ACK order.
  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300]) {
    assert.equal(transport.sendControlJson(health(7, capturedSamples)).sent, true);
  }

  // Every delayed ACK reports the same accepted PCM serial. Request-correlated
  // send-time snapshots must preserve the advancing local frontier, so control
  // latency cannot hide a real server-side media stall.
  for (let index = 0; index < 4; index += 1) {
    socket.emitJson(ack(7, 10, 'webtransport'));
  }
  assert.equal(transport.stats().path, 'websocket');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 1);
  assert.equal(socket.closeCalls.length, 0);
});

test('late WT acceptance cannot prove fallback before the server reports WS and then accepts another frame', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' });

  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300]) {
    transport.sendControlJson(health(7, capturedSamples));
    socket.emitJson(ack(7, 10, 'webtransport'));
  }
  assert.equal(transport.stats().path, 'websocket');

  // This serial advancement may be a WT datagram already in flight when local
  // demotion happened. Server still says WT, so it is not recovery evidence.
  transport.sendControlJson(health(7, 1_400));
  socket.emitJson(ack(7, 11, 'webtransport'));
  assert.equal(socket.closeCalls.length, 0);

  // First server-WS observation is only a fresh baseline.
  transport.sendControlJson(health(7, 1_500));
  socket.emitJson(ack(7, 11, 'websocket'));
  assert.equal(socket.closeCalls.length, 0);

  // A later accepted frame on the now-confirmed WS path proves recovery.
  transport.sendControlJson(health(7, 1_600));
  socket.emitJson(ack(7, 12, 'websocket'));
  assert.equal(socket.closeCalls.length, 0);

  // The successful fallback remains generation-scoped: do not re-promote WT.
  assert.equal(await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' }), false);
});

test('stalled WS recovery requests exactly one physical replacement and fences late old-socket ACKs', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const first = new EventSocket();
  transport.bind(first);

  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300]) {
    transport.sendControlJson(health(7, capturedSamples));
    first.emitJson(ack(7, 10, 'websocket'));
  }

  assert.equal(first.closeCalls.length, 1);
  assert.equal(first.closeCalls[0].code, 4001);

  // The close request increments the transport's socket epoch immediately, so
  // an ACK queued on the retired socket cannot spend another recovery action.
  first.emitJson(ack(7, 99, 'websocket'));
  assert.equal(first.closeCalls.length, 1);

  const replacement = new EventSocket();
  transport.bind(replacement);
  transport.sendControlJson(health(7, 1_400));
  replacement.emitJson(ack(7, 10, 'websocket'));
  assert.equal(replacement.closeCalls.length, 0);

  // No same-generation WT promotion is allowed while the WS proof is active.
  assert.equal(await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' }), false);
});

test('recovered capture backlog stays local when later sample coverage is scored', async () => {
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport();
  const socket = new EventSocket();
  transport.bind(socket);

  const sendPackets = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      assert.equal(transport.send(new Uint8Array(100)).sent, true);
    }
  };
  const emitAck = (
    acceptedFrameSerial: number,
    receivedPacketSerial: number,
    receivedSampleSerial: number,
  ) => socket.emitJson({
    type: 'audio-uplink-health-ack',
    version: 1,
    captureGeneration: 7,
    pcm: {
      acceptedFrameSerial,
      receivedPacketSerial,
      receivedSampleSerial,
      mediaPath: 'websocket',
    },
  });

  sendPackets(100);
  transport.sendControlJson({
    ...health(7, 48_000),
    droppedSamples: { captureBacklog: 0 },
  });
  emitAck(100, 100, 48_000);

  // 43.2k samples were intentionally discarded before packetization, then the
  // page caught up before the next 1 Hz health snapshot. backlogActive is
  // already false here, so only the cumulative drop counter can attribute the
  // missing capture time correctly.
  sendPackets(100);
  transport.sendControlJson({
    ...health(7, 96_000),
    captureDispatch: {
      lagMs: 20,
      maxLagMs: 900,
      backlogMs: 200,
      backlogActive: false,
    },
    droppedSamples: { captureBacklog: 43_200 },
  });
  emitAck(101, 200, 52_800);

  const decision = (transport as any).lastMediaRecoveryDecision;
  assert.equal(decision?.reason, 'server-pcm-coverage-healthy');
  assert.equal(decision?.packetCoverage, 1);
  assert.equal(decision?.sampleCoverage, 1);
  assert.equal(socket.closeCalls.length, 0);
  assert.equal(transport.stats().path, 'websocket');

  transport.close();
});

test('capture-dispatch backlog rebaselines media recovery instead of blaming WT', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' });

  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300, 1_400, 1_500]) {
    transport.sendControlJson({
      ...health(7, capturedSamples),
      captureDispatch: {
        lagMs: 600,
        maxLagMs: 900,
        backlogMs: 200,
        backlogActive: true,
      },
    });
    socket.emitJson(ack(7, 10, 'webtransport'));
  }

  assert.equal(
    transport.stats().path,
    'webtransport',
    'intentional pre-transport stale drops are not WT underdelivery',
  );

  // Once fresh capture resumes, ordinary media-path diagnosis is re-armed.
  for (const capturedSamples of [1_600, 1_700, 1_800, 1_900]) {
    transport.sendControlJson({
      ...health(7, capturedSamples),
      captureDispatch: {
        lagMs: 20,
        maxLagMs: 900,
        backlogMs: 200,
        backlogActive: false,
      },
    });
    socket.emitJson(ack(7, 10, 'webtransport'));
  }
  assert.equal(transport.stats().path, 'websocket');
});

test('muted-source health rebaselines media recovery instead of spending WT recovery', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' });

  // A muted MediaStreamTrack may keep WebAudio and the capture cursor moving
  // with zero PCM. Even if the server acceptance serial is flat, this is
  // already a known source failure and must not consume WT/WS recovery budget.
  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300, 1_400, 1_500]) {
    transport.sendControlJson({
      ...health(7, capturedSamples),
      inputMuted: true,
    });
    socket.emitJson(ack(7, 10, 'webtransport'));
  }

  assert.equal(transport.stats().path, 'webtransport');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 0);
  assert.equal((transport as any).mediaPathRecovery.status().webTransportDemotionUsed, false);

  // Unmute is a fresh diagnosis boundary. The muted interval is not charged
  // retroactively; only subsequent stale live-source observations may demote WT.
  for (const capturedSamples of [1_600, 1_700, 1_800, 1_900]) {
    transport.sendControlJson({
      ...health(7, capturedSamples),
      inputMuted: false,
    });
    socket.emitJson(ack(7, 10, 'webtransport'));
  }

  assert.equal(transport.stats().path, 'websocket');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 1);
});

test('active input-gap health rebaselines media recovery instead of blaming WT', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' });

  // #378 promotes sustained worklet input loss into explicit source authority.
  // Padded zero PCM can still advance capturedSamples, so that interval must
  // not consume the independent WT/WS recovery budget.
  for (const capturedSamples of [1_000, 1_100, 1_200, 1_300, 1_400, 1_500]) {
    transport.sendControlJson({
      ...health(7, capturedSamples),
      inputMuted: false,
      inputGapActive: true,
    });
    socket.emitJson(ack(7, 10, 'webtransport'));
  }

  assert.equal(transport.stats().path, 'webtransport');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 0);
  assert.equal((transport as any).mediaPathRecovery.status().webTransportDemotionUsed, false);

  // Gap recovery is a fresh diagnosis boundary. Do not charge the synthetic
  // silence interval retroactively; the recovery-edge ACK is baseline-only.
  transport.sendControlJson({
    ...health(7, 1_600),
    inputMuted: false,
    inputGapActive: false,
  });
  socket.emitJson(ack(7, 10, 'webtransport'));
  assert.equal((transport as any).lastMediaRecoveryDecision?.reason, 'eligible-rebaseline');
  assert.equal((transport as any).mediaPathRecovery.status().staleObservations, 0);
  assert.equal(transport.stats().path, 'webtransport');

  // Only three subsequent stale live-source observations may spend the WT action.
  for (const capturedSamples of [1_700, 1_800]) {
    transport.sendControlJson({
      ...health(7, capturedSamples),
      inputMuted: false,
      inputGapActive: false,
    });
    socket.emitJson(ack(7, 10, 'webtransport'));
    assert.equal(transport.stats().path, 'webtransport');
  }
  transport.sendControlJson({
    ...health(7, 1_900),
    inputMuted: false,
    inputGapActive: false,
  });
  socket.emitJson(ack(7, 10, 'webtransport'));

  assert.equal(transport.stats().path, 'websocket');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 1);
});

test('background freeze with zero hidden health still makes foreground baseline-only', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' });

  transport.sendControlJson(health(7, 1_000));
  socket.emitJson(ack(7, 10, 'webtransport'));
  transport.sendControlJson(health(7, 1_100));
  socket.emitJson(ack(7, 10, 'webtransport'));
  assert.equal((transport as any).mediaPathRecovery.status().staleObservations, 1);

  // One more visible-state health is already in flight when the page hides.
  // Its delayed ACK must not consume the just-created background boundary.
  transport.sendControlJson(health(7, 1_200));

  // visibilitychange:hidden fires, then iOS freezes the page before any hidden
  // health interval can run.
  transport.noteSourceIneligibleBoundary();
  socket.emitJson(ack(7, 10, 'webtransport'));
  assert.equal(
    (transport as any).mediaPathRecovery.status().staleObservations,
    0,
    'a delayed pre-hide ACK cannot reopen media diagnosis after the boundary',
  );

  // First health after foreground spans the entire frozen interval. It must
  // only establish a new baseline, not count as stale observation #1.
  transport.sendControlJson(health(7, 5_000));
  socket.emitJson(ack(7, 10, 'webtransport'));
  assert.equal((transport as any).lastMediaRecoveryDecision?.reason, 'eligible-rebaseline');
  assert.equal((transport as any).mediaPathRecovery.status().staleObservations, 0);
  assert.equal(transport.stats().path, 'webtransport');

  for (const capturedSamples of [5_100, 5_200]) {
    transport.sendControlJson(health(7, capturedSamples));
    socket.emitJson(ack(7, 10, 'webtransport'));
    assert.equal(transport.stats().path, 'webtransport');
  }
  transport.sendControlJson(health(7, 5_300));
  socket.emitJson(ack(7, 10, 'webtransport'));
  assert.equal(transport.stats().path, 'websocket');
  assert.equal(FakeWebTransport.instances[0].closeCalls, 1);
});

test('hidden-page health ACKs rebaseline and never trigger semantic media recovery', async () => {
  FakeWebTransport.instances.length = 0;
  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: FakeWebTransport });
  const socket = new EventSocket();
  transport.bind(socket);
  await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media' });

  const previousDocument = (globalThis as { document?: unknown }).document;
  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState: 'hidden' },
    configurable: true,
  });
  try {
    for (const capturedSamples of [1_000, 1_100, 1_200, 1_300, 1_400, 1_500]) {
      transport.sendControlJson(health(7, capturedSamples));
      socket.emitJson(ack(7, 10, 'webtransport'));
    }
    assert.equal(transport.stats().path, 'webtransport');
    assert.equal(socket.closeCalls.length, 0);
  } finally {
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, 'document', {
      value: previousDocument,
      configurable: true,
    });
  }
});
