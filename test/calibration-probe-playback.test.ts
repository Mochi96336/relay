import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const messages: any[] = [];
  const resumes: ReturnType<typeof deferred>[] = [];
  const oscillators: any[] = [];
  const gains: any[] = [];
  const send = { sent: true, reason: null as string | null };
  let staleCalls = 0;
  const context = {
    currentTime: 10, state: 'running',
    resume() { const wait = deferred(); resumes.push(wait); return wait.promise; },
    createOscillator() {
      const node = {
        frequency: { value: 0 }, starts: [] as number[], stops: [] as (number | undefined)[],
        disconnects: 0, ended: null as null | (() => void),
        connect(target: any) { return target; },
        start(at: number) { this.starts.push(at); },
        stop(at?: number) { this.stops.push(at); },
        disconnect() { this.disconnects++; },
        addEventListener(_event: string, fn: () => void) { this.ended = fn; },
      };
      oscillators.push(node);
      return node;
    },
    createGain() {
      const node = {
        ramps: [] as number[][], disconnects: 0,
        gain: {
          setValueAtTime(value: number, at: number) { node.ramps.push([value, at]); },
          exponentialRampToValueAtTime(value: number, at: number) { node.ramps.push([value, at]); },
        },
        connect() {}, disconnect() { this.disconnects++; },
      };
      gains.push(node);
      return node;
    },
    destination: {},
  };
  const env = {
    performance: { now: () => 100 }, publisherSessionEpoch: 1, captureGeneration: 2,
    activeCalibrationProbeRequestId: null as number | null, activeCalibrationProbePlayback: null,
    isCurrentPublisherCapture: (epoch: number, generation: number) => epoch === env.publisherSessionEpoch && generation === env.captureGeneration,
    document: { visibilityState: 'visible' }, socket: { readyState: 1 }, WebSocket: { OPEN: 1 },
    audioContext: context, audioTransport: { sendControlJson: (message: any) => { messages.push(message); return send; } },
    markPublisherAuthorityStale: () => { staleCalls++; },
    probeTimingDiagnostics: () => ({ processingMs: 0 }), console: { warn() {} },
  };
  const source = parseTypeScriptSource(new URL('../public/app.js', import.meta.url), readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));
  const scope = vm.createContext(env);
  vm.runInContext(`const PROBE_NOTES = ${variableInitializerCode(source, 'PROBE_NOTES')};
    const PROBE_NOTE_SECONDS = ${variableInitializerCode(source, 'PROBE_NOTE_SECONDS')};
    ${functionCode(source, 'retireCalibrationProbePlayback')}
    async ${functionCode(source, 'playCalibrationProbe')}`, scope);
  return {
    env, context, messages, resumes, oscillators, gains, send,
    staleCalls: () => staleCalls,
    play(requestId = 3) {
      vm.runInContext('retireCalibrationProbePlayback()', scope);
      env.activeCalibrationProbeRequestId = requestId;
      return vm.runInContext(`playCalibrationProbe(${requestId}, 200)`, scope) as Promise<void>;
    },
    cancelPending() { env.activeCalibrationProbeRequestId = null; },
    retire() { env.activeCalibrationProbeRequestId = null; vm.runInContext('retireCalibrationProbePlayback()', scope); },
  };
}

async function scheduled(f: ReturnType<typeof fixture>, id = 3) {
  const playing = f.play(id);
  f.resumes.at(-1)!.resolve();
  await playing;
}

function assertSilent(f: ReturnType<typeof fixture>) {
  assert.equal(f.oscillators.length, 0);
  assert.deepEqual(f.messages, []);
}

test('probe keeps its waveform, schedule and immutable wire identity', async () => {
  const f = fixture();
  await scheduled(f);
  assert.deepEqual(f.oscillators.map(n => n.frequency.value), [1046.5, 1318.5, 1568]);
  assert.deepEqual(f.oscillators.map(n => n.starts[0]), [10.2, 10.325, 10.53]);
  assert.deepEqual(f.oscillators.map(n => n.stops[0]), [10.305, 10.43, 10.635]);
  assert.deepEqual(f.gains.map(n => n.ramps[1][0]), [0.24, 0.27, 0.32]);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].type, 'calibration-probe-played');
  assert.equal(f.messages[0].target, 'mic');
  assert.equal(f.messages[0].requestId, 3);
  assert.equal(f.messages[0].generation, 2);
});

for (const boundary of ['request cancelled', 'capture changed', 'session changed', 'socket closed']) {
  test(`late resume after ${boundary} creates no nodes and sends no reply`, async () => {
    const f = fixture();
    const playing = f.play();
    if (boundary === 'request cancelled') f.cancelPending();
    if (boundary === 'capture changed') f.env.captureGeneration++;
    if (boundary === 'session changed') f.env.publisherSessionEpoch++;
    if (boundary === 'socket closed') f.env.socket.readyState = 3;
    f.resumes[0].resolve();
    await playing;
    assertSilent(f);
  });
}

test('a new request wins even if the old resume finishes after it', async () => {
  const f = fixture();
  const old = f.play(3);
  const next = f.play(4);
  f.resumes[1].resolve();
  await next;
  f.resumes[0].resolve();
  await old;
  assert.equal(f.oscillators.length, 3);
  assert.deepEqual(f.messages.map(m => m.requestId), [4]);
});

test('old resume rejection cannot cancel or fail a new request', async () => {
  const f = fixture();
  const old = f.play(3);
  const next = f.play(4);
  f.resumes[0].reject(new Error('old interrupted context'));
  await old;
  f.resumes[1].resolve();
  await next;
  assert.deepEqual(f.messages.map(m => [m.type, m.requestId]), [['calibration-probe-played', 4]]);
});

test('retiring future-scheduled playback stops and disconnects all its nodes once', async () => {
  const f = fixture();
  await scheduled(f);
  f.retire();
  f.retire();
  assert.deepEqual(f.oscillators.map(n => n.stops), [[10.305, undefined], [10.43, undefined], [10.635, undefined]]);
  assert.deepEqual(f.oscillators.map(n => n.disconnects), [1, 1, 1]);
  assert.deepEqual(f.gains.map(n => n.disconnects), [1, 1, 1]);
});

test('old ended callbacks do not make the new playback unreachable for cancellation', async () => {
  const f = fixture();
  await scheduled(f, 3);
  const old = [...f.oscillators];
  await scheduled(f, 4);
  old.forEach(n => n.ended());
  f.retire();
  assert.deepEqual(f.oscillators.slice(3).map(n => n.disconnects), [1, 1, 1]);
});

for (const reason of ['disconnected', 'congested']) {
  test(`failed played ACK (${reason}) silences scheduled nodes`, async () => {
    const f = fixture();
    Object.assign(f.send, { sent: false, reason });
    await scheduled(f);
    assert.deepEqual(f.oscillators.map(n => n.disconnects), [1, 1, 1]);
    assert.equal(f.staleCalls(), reason === 'disconnected' ? 1 : 0);
    assert.equal(f.messages.length, 1);
  });
}

test('server advancement cancels only preparation, not an acknowledged playback', async () => {
  const f = fixture();
  await scheduled(f);
  f.cancelPending();
  assert.deepEqual(f.oscillators.map(n => n.disconnects), [0, 0, 0]);
  f.retire();
  assert.deepEqual(f.oscillators.map(n => n.disconnects), [1, 1, 1]);
});
