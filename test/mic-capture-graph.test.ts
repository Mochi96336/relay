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
