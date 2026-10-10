import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';
const source = parseTypeScriptSource(new URL('../public/app.js', import.meta.url),
  readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));

function harness(load: () => Promise<void> = async () => {}) {
  const events: string[] = [];
  const contexts: any[] = [];
  const old = { close: async () => { events.push('close-old'); } };
  const stream = { id: 'retained-track' }, graph = {};
  const env: any = { captureGraphRebuildPromise: null, publisherSessionEpoch: 1,
    captureGeneration: 7, audioContext: old, mediaStream: stream, activeCaptureGraph: graph,
    activeNode: {}, publisherActive: true, owns: true,
    setTimeout, clearTimeout, console: { warn() {}, error() {} },
    isCurrentPublisherCapture: (_epoch: number, gen: number) => env.owns && gen === env.captureGeneration,
    isCurrentPublisherSession: () => env.owns,
    disposeCaptureGraph: () => events.push('dispose'),
    advanceCaptureGeneration: () => { events.push('generation'); return ++env.captureGeneration; },
    installCaptureGraph: (_epoch: number, s: object, c: object) => {
      assert.equal(s, stream); assert.equal(c, contexts[0]); events.push('install');
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
  const first = h.run();
  assert.equal(h.run(), first, 'overlapping rebuilds share one operation');
  assert.equal(await first, true);
  assert.equal(h.env.audioContext, h.contexts[0]);
  assert.equal(h.env.captureGeneration, 8);
  assert.deepEqual(h.events, ['dispose','close-old','generation','install','measured-recovery','reconnect','watchdog']);
  assert.equal(h.env.captureGraphRebuildPromise, null);
});

test('retired preparation closes its new context without modifying the newer Mic session', async () => {
  let finish!: () => void;
  const h = harness(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = h.run();
  await Promise.resolve();
  h.env.owns = false;
  const newOwner = {}; h.env.audioContext = newOwner;
  finish();
  assert.equal(await first, false);
  assert.deepEqual(h.events, ['close-new']);
  assert.equal(h.env.audioContext, newOwner);
  assert.equal(h.env.captureGeneration, 7);
});

test('failed context preparation follows bounded Mic retry and closes the failed context', async () => {
  const h = harness(async () => { throw Error('load failed'); });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.events, ['stop','close-new']);
  assert.equal(h.env.captureGeneration, 7);
});
