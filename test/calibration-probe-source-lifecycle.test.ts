import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('robot backing probe loses authority before a late AudioContext resume can enter the mix', async () => {
  const source = await readFile(new URL('../public/source.js', import.meta.url), 'utf8');

  assert.match(source, /let activeBackingProbeRequestId = null/);
  assert.match(source, /activeBackingProbeRequestId = requestId;[\s\S]*playBackingProbe\(requestId/,
    'each backing request must install an explicit local authority token');
  assert.match(source, /await context\.resume\(\);[\s\S]*activeBackingProbeRequestId !== requestId/,
    'a late resume must re-check the request before scheduling backing-path oscillators');
  assert.match(source, /message\.probePhase !== 'backing-requested'[\s\S]*activeBackingProbeRequestId = null/,
    'canonical server probe phase must retire timed-out or advanced backing requests');
  assert.match(source, /function parkSupersededRobot\(\)[\s\S]*activeBackingProbeRequestId = null/,
    'source replacement must retire any old backing probe');
  assert.match(source, /next\.addEventListener\('close'[\s\S]*activeBackingProbeRequestId = null/,
    'losing the source-control socket must retire the pending backing probe');
});

test('the Robot keeps Choir’s pending tone through a primary status and retires it when the duet ends', async () => {
  const vm = await import('node:vm');
  const source = (await readFile(new URL('../public/source.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
  const node = { value: '0', addEventListener() {} };
  const handlers = new Map<string, (event: { data: string }) => void>();
  const sent: string[] = [];
  let resume!: () => void;
  let tones = 0;
  let closed = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    addEventListener(type: string, fn: (event: { data: string }) => void) { handlers.set(type, fn); }
    close() {}
    send(payload: string) { sent.push(JSON.parse(payload).type); }
  }
  class Context {
    state = 'running';
    currentTime = 0;
    createConstantSource() { return { offset: {}, connect() {}, start() {} }; }
    resume() { return new Promise<void>(resolve => { resume = resolve; }); }
    close() { closed++; return Promise.resolve(); }
    createOscillator() { return { frequency: {}, connect: (target: object) => target,
      start() { tones++; }, stop() {} }; }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  vm.runInNewContext(source, {
    WebSocket: Socket, AudioContext: Context, wsUrl: () => 'ws://localhost', window: { YT: { Player() {} } },
    document: { querySelector: () => node, querySelectorAll: () => [] },
    location: { search: '?robot=1', hash: '' }, URLSearchParams, performance,
    setInterval() {}, clearTimeout, console, formatTime: String, probeTimingDiagnostics: () => null,
  });
  const message = (payload: object) => handlers.get('message')!({ data: JSON.stringify(payload) });
  const request = (id: number) => message({ type: 'play-calibration-probe', target: 'backing', owner: 'choir', requestId: id });
  request(10);
  message({ type: 'timing-calibration-status', probeActive: false });
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tones, 3);
  assert.deepEqual(sent, ['calibration-probe-played']);
  request(11);
  message({ type: 'choir-probe-retired', requestId: 11 });
  message({ type: 'choir-probe-retired', requestId: 10 });
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tones, 3);
  assert.equal(closed, 1, 'ending the duet silences its already scheduled backing nodes');
  request(12);
  message({ type: 'robot-source-replaced' });
  assert.equal(closed, 2, 'superseding the page retires its dedicated audio context');
});
