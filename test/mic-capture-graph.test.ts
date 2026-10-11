import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFixture } from './support/capture-graph-fixture.js';

const analysis = { type: 'analysis', spectrumBands: [1, 2, 3, 4, 5], f0Hz: 220, pitchConfidence: 0.9 };

function deferred() {
  let resolve!: (value: any[]) => void;
  const promise = new Promise<any[]>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('graph installs silent output, timestamp protocol and worker configuration before admission', () => {
  const f = captureFixture();
  const graph = f.install();
  assert.equal(graph.context, f.context);
  assert.equal(graph.stream, f.stream);
  assert.equal(graph.captureClockOriginContextTime, 3);
  assert.equal(f.env.activeCaptureGraph, graph);
  assert.equal(f.nodes.find(n => n.kind === 'gain').gain.value, 0);
  assert.deepEqual(graph.capture.port.posted, [{ type: 'capture-protocol', pcmEnvelope: true }]);
  assert.equal(f.workers[0].url, '/mic-visual-analysis-worker.js');
  assert.equal(f.workers[0].options.name, 'relay-mic-visual-analysis');
  assert.deepEqual(f.workers[0].posted, [{ type: 'configure', sampleRate: 48000 }]);
  graph.capture.port.onmessage({ data: 'current capture' });
  assert.deepEqual(f.messages, ['current capture']);
});

test('dispose removes listeners, disconnects nodes and terminates only graph resources', () => {
  const f = captureFixture();
  const graph = f.install();
  f.dispose(graph);
  f.dispose(graph);
  assert.equal(graph.capture.port.onmessage, null);
  assert.equal(f.events.get('devicechange')?.size, 0);
  assert.equal(graph.capture.listeners.get('processorerror')?.size, 0);
  assert.equal(f.workers[0].terminations, 1);
  assert.ok(f.nodes.every(n => !n.connected));
  assert.equal(f.context.closes, 0);
  assert.equal(f.track.stops, 0);
});

test('visual PCM is copied before transfer, original capture bytes return separately', () => {
  const f = captureFixture();
  const graph = f.install();
  const pcm = new Uint8Array([1, 2, 3, 4]).buffer;
  f.analyze(graph, pcm);
  assert.deepEqual([...new Uint8Array(pcm)], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(f.workers[0].posted[1].buffer)], [1, 2, 3, 4]);
  f.returnBuffer(graph, pcm);
  assert.equal(pcm.byteLength, 0);
  assert.deepEqual([...new Uint8Array(graph.capture.port.posted[1].buffer)], [1, 2, 3, 4]);
});

for (const boundary of ['graph object', 'graph epoch', 'session', 'stream', 'context']) {
  test(`old processor and analysis callbacks lose authority after ${boundary} changes`, () => {
    const f = captureFixture();
    const graph = f.install();
    const processor = [...graph.capture.listeners.get('processorerror')][0] as () => void;
    const workerMessage = f.workers[0].onmessage;
    if (boundary === 'graph object') f.env.activeCaptureGraph = {};
    if (boundary === 'graph epoch') f.env.captureGraphEpoch++;
    if (boundary === 'session') f.env.publisherSessionEpoch++;
    if (boundary === 'stream') f.env.mediaStream = {};
    if (boundary === 'context') f.env.audioContext = {};
    processor();
    workerMessage({ data: analysis });
    assert.deepEqual(f.effects, []);
    assert.equal(graph.visualAnalysis, null);
    f.dispose(graph);
  });
}

test('processor error recovery preserves the bounded policy and Mic ownership', () => {
  const f = captureFixture();
  const graph = f.install();
  graph.capture.emit('processorerror');
  f.env.processorDecision = { rebuild: false, exhausted: true };
  graph.capture.emit('processorerror');
  assert.deepEqual(f.effects, ['processor-error', 'processor-error-repeated:false']);
});

for (const devices of [[], [{ kind: 'audioinput', deviceId: 'mic-a' }], [{ kind: 'videoinput', deviceId: 'camera' }]]) {
  test(`ambiguous or unchanged device list (${JSON.stringify(devices)}) cannot end Mic`, async () => {
    const f = captureFixture(); f.install();
    f.mediaDevices.enumerate = () => Promise.resolve(devices);
    f.mediaDevices.emit(); await f.flush();
    assert.deepEqual(f.effects, []);
  });
}

test('confirmed input removal enters reconnect grace without releasing Mic', async () => {
  const f = captureFixture(); f.install();
  f.mediaDevices.enumerate = () => Promise.resolve([{ kind: 'audioinput', deviceId: 'mic-b' }]);
  f.mediaDevices.emit(); await f.flush();
  assert.deepEqual(f.effects, ['input-device-removed:false']);
});

test('route change before or during enumeration rebuilds instead of claiming removal', async () => {
  for (const during of [false, true]) {
    const f = captureFixture(); f.install();
    const wait = deferred();
    f.mediaDevices.enumerate = () => wait.promise;
    if (!during) f.track.deviceId = 'mic-b';
    f.mediaDevices.emit();
    if (during) f.track.deviceId = 'mic-b';
    wait.resolve([{ kind: 'audioinput', deviceId: 'mic-b' }]);
    await f.flush();
    assert.deepEqual(f.effects, ['input-device-changed']);
    assert.equal(f.mediaDevices.enumerations, during ? 1 : 0);
  }
});

test('retired enumeration cannot stop a replacement graph or block its device checks', async () => {
  const f = captureFixture();
  const old = f.install();
  const wait = deferred(); f.mediaDevices.enumerate = () => wait.promise;
  f.mediaDevices.emit(); f.mediaDevices.emit();
  assert.equal(f.mediaDevices.enumerations, 1);
  f.dispose(old);
  const current = f.install();
  const next = deferred(); f.mediaDevices.enumerate = () => next.promise;
  f.mediaDevices.emit();
  wait.resolve([{ kind: 'audioinput', deviceId: 'mic-b' }]); await f.flush();
  f.mediaDevices.emit();
  assert.equal(f.mediaDevices.enumerations, 2, 'old finally cannot release the new pending guard');
  assert.deepEqual(f.effects, []);
  next.resolve([{ kind: 'audioinput', deviceId: 'mic-a' }]); await f.flush();
  f.dispose(current);
});

for (const failure of ['source', 'worklet', 'gain', 'protocol', 'connect-source', 'connect-worklet', 'connect-gain']) {
  test(`partial graph failure (${failure}) releases every acquired resource without activation`, () => {
    const f = captureFixture(failure);
    assert.throws(() => f.install(), new RegExp(failure));
    assert.ok(f.nodes.every(n => n.disconnects === 1));
    assert.ok(f.workers.every(w => w.terminations === 1));
    assert.equal(f.events.get('devicechange')?.size ?? 0, 0);
    assert.ok(f.nodes.every(n => (n.listeners.get('processorerror')?.size ?? 0) === 0));
    assert.equal(f.env.activeCaptureGraph, null);
    assert.equal(f.env.captureGraphEpoch, 0);
    assert.equal(f.context.closes, 0);
    assert.equal(f.track.stops, 0);
  });
}

for (const failure of ['worker-create', 'worker-configure', 'worker-pcm']) {
  test(`optional visualization failure (${failure}) leaves capture live and terminates any worker`, () => {
    const f = captureFixture(failure);
    const graph = f.install();
    if (failure === 'worker-pcm') f.analyze(graph, new ArrayBuffer(8));
    assert.ok(f.workers.every(w => w.terminations === 1));
    graph.capture.port.onmessage({ data: 'capture survives visual failure' });
    assert.deepEqual(f.messages, ['capture survives visual failure']);
    f.dispose(graph);
    assert.ok(f.workers.every(w => w.terminations === 1), 'worker closes exactly once');
  });
}

test('queued callbacks and PCM writes after disposal cannot regain authority while app still references graph', () => {
  const f = captureFixture();
  const graph = f.install();
  const pcm = graph.capture.port.onmessage;
  const processor = [...graph.capture.listeners.get('processorerror')][0] as () => void;
  const device = [...f.events.get('devicechange')!][0];
  const workerMessage = f.workers[0].onmessage;
  f.dispose(graph);
  pcm({ data: 'retired' }); processor(); device(); workerMessage({ data: analysis });
  const buffer = new ArrayBuffer(8);
  f.analyze(graph, buffer); f.returnBuffer(graph, buffer);
  assert.equal(buffer.byteLength, 8);
  assert.equal(graph.capture.port.posted.length, 1);
  assert.equal(f.workers[0].posted.length, 1);
  assert.equal(graph.visualAnalysis, null);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.messages, []);
  assert.equal(f.mediaDevices.enumerations, 0);
  assert.ok(f.nodes.every(n => n.disconnects === 1));
});

test('late message from a failed visual worker cannot replace current analysis', () => {
  const f = captureFixture();
  const graph = f.install();
  const workerMessage = f.workers[0].onmessage;
  workerMessage({ data: analysis });
  assert.equal(graph.visualAnalysis.f0Hz, 220);
  f.workers[0].onerror();
  workerMessage({ data: { ...analysis, f0Hz: 440 } });
  assert.equal(graph.visualAnalysis.f0Hz, 220);
  f.dispose(graph);
  assert.equal(f.workers[0].terminations, 1);
});

for (const synchronous of [false, true]) {
  test(`enumeration ${synchronous ? 'throws' : 'rejects'} without ending Mic or wedging later checks`, async () => {
    const f = captureFixture(); const graph = f.install();
    f.mediaDevices.enumerate = () => {
      if (synchronous) throw new Error('enumeration unavailable');
      return Promise.reject(new Error('enumeration unavailable'));
    };
    assert.doesNotThrow(() => f.mediaDevices.emit());
    await f.flush();
    assert.deepEqual(f.effects, []);
    f.mediaDevices.enumerate = () => Promise.resolve([{ kind: 'audioinput', deviceId: 'mic-b' }]);
    f.mediaDevices.emit(); await f.flush();
    assert.deepEqual(f.effects, ['input-device-removed:false']);
    f.dispose(graph);
  });
}

test('construction callbacks are not admitted before publisher activates the completed graph', () => {
  const f = captureFixture();
  f.env.beforeConnect = () => {
    const capture = f.nodes.find(n => n.kind === 'worklet');
    capture.port.onmessage({ data: 'too early' });
    capture.emit('processorerror');
    f.mediaDevices.emit();
    f.workers[0].onmessage({ data: analysis });
  };
  const graph = f.install();
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.messages, []);
  assert.equal(graph.visualAnalysis, null);
  assert.equal(f.mediaDevices.enumerations, 0);
  graph.capture.port.onmessage({ data: 'active' });
  assert.deepEqual(f.messages, ['active']);
  f.dispose(graph);
});

test('failed replacement preparation cleans its own nodes without disposing the current graph', () => {
  const f = captureFixture();
  const current = f.install();
  const oldNodes = [...f.nodes];
  f.setFailure('gain');
  assert.throws(() => f.install(), /gain/);
  assert.equal(f.env.activeCaptureGraph, current);
  assert.equal(f.env.captureGraphEpoch, 1);
  assert.ok(oldNodes.every(n => n.disconnects === 0));
  assert.ok(f.nodes.slice(oldNodes.length).every(n => n.disconnects === 1));
  assert.equal(f.workers[0].terminations, 0);
  current.capture.port.onmessage({ data: 'existing graph' });
  assert.deepEqual(f.messages, ['existing graph']);
  f.dispose(current);
});
