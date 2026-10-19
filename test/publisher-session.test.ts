import assert from 'node:assert/strict';
import test from 'node:test';
import { PublisherSession, type CaptureSnapshot, type PublisherEncoder } from '../public/publisher-session.js';
import type { MicCaptureGraph } from '../public/mic-capture-graph.js';
import { deferred } from './support/deferred.js';

function fixture(close = async () => {}) {
  const events: string[] = [];
  const session = new PublisherSession({ closeMedia: () => { events.push('media'); } });
  function capture() {
    const stream = { getTracks: () => [{ stop() { events.push('track'); } }] } as unknown as MediaStream;
    const context = { async close() { events.push('context'); await close(); } } as unknown as AudioContext;
    const encoder = { bitrate: 128000, close() { events.push('encoder'); } } as PublisherEncoder;
    return { stream, context, encoder };
  }
  function activate() {
    const attempt = session.beginStartup();
    const resources = capture();
    const epoch = session.activate(attempt, resources)!;
    return { ...resources, epoch };
  }
  function graph(epoch = session.epoch, context = session.context!, stream = session.stream!) {
    return { epoch: session.graphEpoch + 1, sessionEpoch: epoch, context, stream,
      dispose() { events.push('graph'); } } as MicCaptureGraph;
  }
  function snapshot(): CaptureSnapshot {
    return { epoch: session.epoch, generation: session.generation,
      context: session.context!, stream: session.stream!, graph: session.graph };
  }
  function socket() {
    return { readyState: 1, send(value: string) { events.push(JSON.parse(value).type); },
      close() { events.push('socket'); } } as unknown as WebSocket;
  }
  return { session, events, capture, activate, graph, snapshot, socket };
}

test('only the current startup can transfer prepared resources', () => {
  const f = fixture();
  const first = f.session.beginStartup();
  const second = f.session.beginStartup();
  assert.equal(f.session.activate(first, f.capture()), null);
  assert.equal(f.session.active, false);
  assert.equal(f.session.starting, true);
  const prepared = f.capture();
  assert.equal(f.session.activate(second, prepared), f.session.epoch);
  assert.equal(f.session.context, prepared.context);
  assert.equal(f.session.starting, false);
  assert.throws(() => f.session.beginStartup(), /Stop the active Mic/);
});

test('retirement cancels pending permission and prevents late activation', async () => {
  const f = fixture();
  const attempt = f.session.beginStartup();
  const permission = deferred<MediaStream>();
  const pending = f.session.startup.wait(attempt, permission.promise, {
    dispose: stream => { stream.getTracks().forEach(track => track.stop()); },
  });
  f.session.retire();
  await assert.rejects(pending, { name: 'MicStartupCancelledError' });
  permission.resolve(f.capture().stream);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.events, ['track']);
  assert.equal(f.session.activate(attempt, f.capture()), null);
});

test('retirement waits for known startup cleanup without waiting on unresolved browser work', async () => {
  const f = fixture(); const closed = deferred<void>();
  const attempt = f.session.beginStartup();
  f.session.startup.own(attempt, {}, () => closed.promise);
  const waiting = f.session.startup.wait(attempt, new Promise<void>(() => {}));
  const closing = f.session.retire().finish({ releaseMic: false });
  await assert.rejects(waiting, { name: 'MicStartupCancelledError' });
  let finished = false; void closing.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  closed.resolve(); await closing; assert.equal(finished, true);
});

test('stop revokes every resource before cleanup, releases before socket close and waits for context', async () => {
  const closed = deferred<void>();
  const f = fixture(() => closed.promise);
  const { epoch } = f.activate();
  const graph = f.graph(); f.session.adoptGraph(epoch, graph);
  f.session.bindSocket(epoch, f.session.generation, f.socket());
  const retired = f.session.retire();
  assert.equal(f.session.active, false);
  assert.equal(f.session.context, null);
  assert.equal(f.session.stream, null);
  assert.equal(f.session.socket, null);
  assert.equal(f.session.encoder, null);
  assert.equal(f.session.graph, null);
  assert.equal(f.session.isCurrentSession(epoch), false);
  assert.equal(f.session.isCurrentGraph(graph), false);
  const first = retired.finish({ releaseMic: true });
  assert.equal(f.session.retire(), retired);
  assert.equal(retired.finish({ releaseMic: false }), first);
  assert.deepEqual(f.events, ['encoder','release-mic','media','socket','track','graph','context']);
  let finished = false; void first.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  closed.resolve(); assert.equal(await first, retired.epoch);
});

test('recoverable stop omits release and cleanup failures cannot strand remaining resources', async () => {
  const f = fixture();
  const { epoch, encoder, stream, context } = f.activate();
  encoder.close = () => { f.events.push('encoder'); throw Error('encoder'); };
  const badTrack = { stop() { f.events.push('bad-track'); throw Error('track'); } } as unknown as MediaStreamTrack;
  const goodTrack = { stop() { f.events.push('good-track'); } } as unknown as MediaStreamTrack;
  stream.getTracks = () => [badTrack, goodTrack];
  context.close = () => { f.events.push('context'); return Promise.reject(Error('context')); };
  const ws = f.socket(); ws.close = () => { f.events.push('socket'); throw Error('socket'); };
  f.session.bindSocket(epoch, f.session.generation, ws);
  f.session.adoptGraph(epoch, f.graph());
  await f.session.retire().finish({ releaseMic: false });
  assert.deepEqual(f.events, ['encoder','media','socket','bad-track','good-track','graph','context']);
});

test('terminal transaction deduplicates synchronous, overlapping and completed signals', async () => {
  const closed = deferred<void>(); const f = fixture(() => closed.promise); f.activate();
  let stops = 0, ended = 0;
  const options = { stop: () => { stops++; return f.session.retire().finish({ releaseMic: true }); },
    onEnded: () => { ended++; } };
  const first = f.session.end(options);
  assert.equal(f.session.active, false, 'revocation happens in the terminal call');
  assert.equal(f.session.end(options), first);
  assert.equal(stops, 1); assert.equal(ended, 0);
  closed.resolve(); assert.equal(await first, true);
  assert.equal(f.session.end(options), first);
  assert.equal(ended, 1); assert.equal(stops, 1);
});

test('old teardown cannot emit ended for a replacement even when both teardowns overlap', async () => {
  const closed = deferred<void>(); const f = fixture(() => closed.promise); f.activate();
  const ended: string[] = [];
  const end = (name: string) => f.session.end({
    stop: () => f.session.retire().finish({ releaseMic: false }), onEnded: () => { ended.push(name); },
  });
  const prior = end('old'); f.activate(); const replacement = end('new');
  assert.notEqual(prior, replacement);
  closed.resolve(); assert.equal(await prior, false); assert.equal(await replacement, true);
  assert.deepEqual(ended, ['new']);
});

test('cleanup callbacks cannot reenter the same physical teardown', async () => {
  const f = fixture(); const { encoder } = f.activate(); let second: Promise<number> | undefined;
  encoder.close = () => { second = f.session.retire().finish({ releaseMic: true }); };
  const first = f.session.retire().finish({ releaseMic: false });
  assert.equal(second, first); await first;
  assert.deepEqual(f.events, ['media','track','context']);
});

test('graph admission validates session, context, stream and monotonic graph identity', () => {
  const f = fixture(); const { epoch } = f.activate(); const graph = f.graph();
  assert.equal(f.session.adoptGraph(epoch, graph), true);
  assert.equal(f.session.isCurrentGraph(graph), true);
  for (const invalid of [
    { ...f.graph(), sessionEpoch: epoch - 1 }, { ...f.graph(), epoch: graph.epoch },
    { ...f.graph(), stream: f.capture().stream }, { ...f.graph(), context: f.capture().context },
  ]) {
    assert.equal(f.session.adoptGraph(epoch, invalid), false);
    assert.equal(f.session.graph, graph);
  }
  const replacement = f.graph(); f.session.adoptGraph(epoch, replacement);
  assert.equal(f.session.isCurrentGraph(graph), false);
  assert.equal(f.session.isCurrentGraph(replacement), true);
  assert.equal(f.events.length, 5, 'each rejected graph and the retired current graph are disposed');
});

test('socket admission closes stale arrivals and old close events cannot detach a replacement', () => {
  const f = fixture(); const { epoch } = f.activate(); const generation = f.session.generation;
  const old = f.socket(), next = f.socket();
  assert.equal(f.session.bindSocket(epoch, generation, old), true);
  assert.equal(f.session.bindSocket(epoch, generation, next), true);
  assert.equal(f.session.detachSocket(old), false);
  f.session.advanceGeneration('route');
  assert.equal(f.session.bindSocket(epoch, generation, f.socket()), false);
  assert.equal(f.session.socket, next);
  assert.equal(f.session.detachSocket(next), true);
  assert.deepEqual(f.events, ['socket','socket']);
});

test('capture generation changes invalidate snapshots without changing the session', () => {
  const f = fixture(); const { epoch } = f.activate(); const previous = f.snapshot();
  const current = f.session.advanceGeneration('input-device');
  assert.equal(current, (previous.generation + 1) >>> 0);
  assert.equal(f.session.generationReason, 'input-device');
  assert.equal(f.session.isCurrentSession(epoch), true);
  assert.equal(f.session.isCurrentCapture(epoch, previous.generation), false);
  assert.equal(f.session.dropGraph(previous), false);
  assert.equal(f.session.replaceContext(previous, f.capture().context), false);
});

test('context replacement retires only graph and old context, retaining stream, encoder and socket', () => {
  const f = fixture(); const active = f.activate(); const graph = f.graph();
  f.session.adoptGraph(active.epoch, graph); const ws = f.socket();
  f.session.bindSocket(active.epoch, f.session.generation, ws);
  const snapshot = f.snapshot(); const prepared = f.capture().context;
  assert.equal(f.session.replaceContext(snapshot, prepared), true);
  assert.equal(f.session.stream, active.stream); assert.equal(f.session.encoder, active.encoder);
  assert.equal(f.session.socket, ws); assert.equal(f.session.context, prepared);
  assert.equal(f.session.graph, null); assert.equal(f.session.isCurrentGraph(graph), false);
  assert.equal(f.session.replaceContext(snapshot, f.capture().context), false);
  assert.deepEqual(f.events, ['graph','context']);
});

test('graph recovery drops graph authority before disposal without closing context or track', () => {
  const f = fixture(); const { epoch } = f.activate(); const graph = f.graph();
  f.session.adoptGraph(epoch, graph);
  graph.dispose = () => { assert.equal(f.session.isCurrentGraph(graph), false); f.events.push('graph'); };
  assert.equal(f.session.dropGraph(f.snapshot()), true);
  assert.deepEqual(f.events, ['graph']); assert.equal(f.session.active, true);
});

test('context and graph recovery share one operation and a current snapshot', async () => {
  const f = fixture(); f.activate(); const done = deferred<boolean>(); let calls = 0;
  const first = f.session.recover(async (snapshot, current) => {
    calls++; assert.equal(snapshot.context, f.session.context); assert.equal(current(), true);
    await done.promise; assert.equal(current(), false); return false;
  });
  assert.equal(f.session.recover(async () => { throw Error('duplicate'); }), first);
  await Promise.resolve(); f.session.advanceGeneration('route'); done.resolve(true);
  assert.equal(await first, false); assert.equal(calls, 1); assert.equal(f.session.recovering, false);
});

test('retired recovery completion never clears a newer session recovery', async () => {
  const f = fixture(); f.activate(); const oldDone = deferred<boolean>(), newDone = deferred<boolean>();
  const old = f.session.recover(async () => oldDone.promise); await Promise.resolve();
  void f.session.retire().finish({ releaseMic: false }); f.activate();
  const next = f.session.recover(async () => newDone.promise);
  oldDone.resolve(false); await old;
  assert.equal(f.session.recovering, true);
  assert.equal(f.session.recover(async () => false), next);
  newDone.resolve(true); assert.equal(await next, true); assert.equal(f.session.recovering, false);
});

test('queued recovery retired before execution has no effects; rejection releases its guard', async () => {
  const f = fixture(); f.activate(); let called = false;
  const pending = f.session.recover(async () => { called = true; return true; });
  void f.session.retire().finish({ releaseMic: false });
  assert.equal(await pending, false); assert.equal(called, false);
  f.activate(); await assert.rejects(f.session.recover(async () => { throw Error('recovery'); }), /recovery/);
  assert.equal(f.session.recovering, false);
});

test('start requests deduplicate before reentrant effects and allow retry after failure', async () => {
  const f = fixture(); const ready = deferred<void>(); let calls = 0;
  const first = f.session.requestStart(async () => {
    calls++; assert.equal(f.session.requestStart(async () => { calls++; }), first); await ready.promise;
  });
  assert.equal(f.session.requestStart(async () => { calls++; }), first);
  ready.resolve(); await first; assert.equal(calls, 1);
  await assert.rejects(f.session.requestStart(async () => { throw Error('permission'); }), /permission/);
  await f.session.requestStart(async () => { calls++; }); assert.equal(calls, 2);
});
