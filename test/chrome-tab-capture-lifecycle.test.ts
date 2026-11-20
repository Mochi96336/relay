import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('stopping a pending tab capture disposes the late stream before creating an audio graph', async () => {
  const source = (await readFile(new URL('../chrome-tab-audio-probe/offscreen.js', import.meta.url), 'utf8'))
    .replace(/^import .*;$/m, '');
  let send!: (message: object) => void;
  let grant!: (stream: object) => void;
  let graphs = 0;
  let stops = 0;
  const replies: object[] = [];
  vm.runInNewContext(source, {
    crypto, clearTimeout, console,
    AudioContext: class { constructor() { graphs++; } },
    chrome: { runtime: {
      onMessage: { addListener: (listener: typeof send) => { send = listener; } },
      sendMessage: async (message: object) => replies.push(message),
    } },
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } },
  });
  send({ target: 'offscreen', type: 'start-capture', tabId: 7, pageUrl: 'http://localhost' });
  await new Promise(resolve => setImmediate(resolve));
  send({ target: 'offscreen', type: 'stop-capture' });
  const track = { stop: () => { stops++; }, addEventListener() {} };
  grant({ getTracks: () => [track], getAudioTracks: () => [track] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(graphs, 0);
  assert.deepEqual(replies, []);
});

test('a second extension click cancels a tab capture whose stream id is pending', async () => {
  const source = await readFile(new URL('../chrome-tab-audio-probe/service-worker.js', import.meta.url), 'utf8');
  let click!: (tab: object) => Promise<void>;
  let grant!: (id: string) => void;
  const commands: string[] = [];
  vm.runInNewContext(source, {
    URL, console, chrome: {
      action: { onClicked: { addListener: (fn: typeof click) => { click = fn; } },
        setBadgeText: async () => {}, setTitle: async () => {} },
      tabs: { onRemoved: { addListener() {} } },
      runtime: { getURL: () => 'offscreen.html', getContexts: async () => [{}],
        sendMessage: async (message: { type: string }) => { commands.push(message.type); },
        onMessage: { addListener() {} } },
      tabCapture: { getMediaStreamId: () => new Promise(resolve => { grant = resolve; }) },
    },
  });
  const tab = { id: 7, url: 'http://localhost/source.html' };
  const pending = click(tab);
  await new Promise(resolve => setImmediate(resolve));
  await click(tab);
  grant('late-stream-id');
  await pending;
  assert.deepEqual(commands, ['stop-capture']);
});

test('a silent backing socket gets a fresh registration, and terminal configuration errors remain visible', async () => {
  const source = (await readFile(new URL('../chrome-tab-audio-probe/offscreen.js', import.meta.url), 'utf8'))
    .replace(/^import .*;$/m, '');
  const timers = new Map<number, () => void>();
  const states: string[] = [];
  const sockets: Socket[] = [];
  class Socket {
    listeners = new Map<string, (event?: object) => void>();
    constructor() { sockets.push(this); }
    close() { this.listeners.get('close')?.(); }
    addEventListener(type: string, fn: (event?: object) => void) { this.listeners.set(type, fn); }
  }
  let id = 0;
  const context = vm.createContext({
    crypto, URL, URLSearchParams, WebSocket: Socket,
    console: { error() {} },
    setTimeout: (run: () => void) => { timers.set(++id, run); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
    chrome: { runtime: { onMessage: { addListener() {} },
      sendMessage: async ({ state }: { state: string }) => states.push(state) } },
  });
  vm.runInContext(source, context);
  vm.runInContext("activeTabId = 7; audioContext = {}; stream = {}; relayPageUrl = 'http://localhost/source.html'; connectRelay();", context);
  assert.equal(sockets.length, 1);
  const runNext = () => {
    const [key, callback] = [...timers.entries()][0];
    timers.delete(key);
    callback();
  };
  runNext();
  assert.equal(states.at(-1), 'disconnected');
  runNext();
  assert.equal(sockets.length, 2);
  sockets[1].listeners.get('open')?.();
  assert.equal(states.at(-1), 'error');
  assert.equal(timers.size, 0, 'the same invalid configuration does not loop');
});
