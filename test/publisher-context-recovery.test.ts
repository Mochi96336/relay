import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { PublisherSession } from '../public/publisher-session.js';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';
const source = parseTypeScriptSource(new URL('../public/app.js', import.meta.url),
  readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));

function harness(load: () => Promise<void> = async () => {}) {
  const events: string[] = [];
  const contexts: any[] = [];
  const old = { close: async () => { events.push('close-old'); } };
  const stream = { id: 'retained-track', getTracks: () => [] };
  const session = new PublisherSession({ closeMedia() {} });
  const epoch = session.activate(session.beginStartup(), {
    stream: stream as unknown as MediaStream, context: old as unknown as AudioContext, encoder: null,
  })!;
  const graph = { epoch: 1, sessionEpoch: epoch, stream, context: old, dispose() { events.push('dispose'); } };
  session.adoptGraph(epoch, graph as unknown as import('../public/mic-capture-graph.js').MicCaptureGraph);
  const env: any = { publisherSession: session,
    micCodecConfig: { opus: false },
    setTimeout, clearTimeout, console: { warn() {}, error() {} },
    isCurrentPublisherCapture: (epoch: number, gen: number) => session.isCurrentCapture(epoch, gen),
    isCurrentPublisherSession: (epoch: number) => session.isCurrentSession(epoch),
    advanceCaptureGeneration: () => { events.push('generation'); return session.advanceGeneration('test'); },
    installCaptureGraph: (_epoch: number, s: object, c: object) => {
      assert.equal(s, stream); assert.equal(c, contexts[0]); events.push('install'); return {};
    },
    micCaptureRecovery: { noteGraphRebuilt: () => events.push('measured-recovery') },
    captureSnapshot: () => ({}),
    restartPublisherConnectionForGeneration: () => events.push('reconnect'),
    startCaptureWatchdog: () => events.push('watchdog'),
    shouldRequestAudioResume: () => false,
    finishMicrophoneSession: async () => { events.push('stop'); },
  };
  env.AudioContext = class {
    state = 'suspended';
    audioWorklet = { addModule: load };
    constructor() { contexts.push(this); }
    async resume() { this.state = 'running'; }
    addEventListener() {}
    async close() { this.state = 'closed'; events.push('close-new'); }
  };
  const context = vm.createContext(env);
  vm.runInContext(functionCode(source, 'rebuildPublisherAudioContext'), context);
  return { env, events, contexts, run: () => vm.runInContext('rebuildPublisherAudioContext()', context) };
}

test('full recovery replaces context, keeps the track and advances capture before reconnecting', async () => {
  const h = harness();
  const generation = h.env.publisherSession.generation;
  const first = h.run();
  assert.equal(h.run(), first, 'overlapping rebuilds share one operation');
  assert.equal(await first, true);
  assert.equal(h.env.publisherSession.context, h.contexts[0]);
  assert.equal(h.env.publisherSession.generation, (generation + 1) >>> 0);
  assert.deepEqual(h.events, ['dispose','close-old','generation','install','measured-recovery','reconnect','watchdog']);
  assert.equal(h.env.publisherSession.recovering, false);
});

test('retired preparation closes its new context without modifying the newer Mic session', async () => {
  let finish!: () => void;
  const h = harness(() => new Promise<void>(resolve => { finish = resolve; }));
  const generation = h.env.publisherSession.generation;
  const first = h.run();
  await Promise.resolve();
  h.env.publisherSession.retire();
  const newOwner = {};
  h.env.publisherSession.activate(h.env.publisherSession.beginStartup(), {
    stream: {}, context: newOwner, encoder: null,
  });
  finish();
  assert.equal(await first, false);
  assert.deepEqual(h.events, ['close-new']);
  assert.equal(h.env.publisherSession.context, newOwner);
  assert.equal(h.env.publisherSession.generation, generation);
});

test('failed context preparation preserves the existing Mic and closes the failed context', async () => {
  const h = harness(async () => { throw Error('load failed'); });
  const generation = h.env.publisherSession.generation;
  assert.equal(await h.run(), false);
  assert.deepEqual(h.events, ['close-new']);
  assert.equal(h.env.publisherSession.generation, generation);
});
