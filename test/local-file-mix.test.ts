import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalFileMix,
  localFileSurface,
  lostMicToAnother,
  roundTripLatencySeconds,
  songDelaySeconds,
} from '../public/local-file-mix.js';

type FakeNode = {
  kind: string;
  edges: Set<FakeNode | object>;
  channelCount?: number;
  channelCountMode?: string;
  gain: { value: number; setTargetAtTime(v: number): void };
  delayTime: { value: number; setTargetAtTime(v: number): void };
  connect(target: any): any;
  disconnect(target?: any): void;
  [key: string]: any;
};

function param(initial = 0) {
  return { value: initial, setTargetAtTime(v: number) { this.value = v; } };
}

function fakeContext({ baseLatency = 0.01, outputLatency = 0.03 } = {}) {
  const nodes: FakeNode[] = [];
  const elementSources = new Map<object, number>();
  const node = (kind: string): FakeNode => {
    const n: FakeNode = {
      kind, edges: new Set(),
      gain: param(1), delayTime: param(0),
      threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
      connect(target: any) { this.edges.add(target); return target; },
      disconnect(target?: any) { if (target) this.edges.delete(target); else this.edges.clear(); },
    };
    nodes.push(n);
    return n;
  };
  const listeners = new Set<() => void>();
  const context = {
    state: 'running', currentTime: 0, baseLatency, outputLatency,
    destination: { kind: 'destination' },
    nodes,
    createGain: () => node('gain'),
    createDelay: () => node('delay'),
    createDynamicsCompressor: () => node('compressor'),
    createMediaElementSource(element: object) {
      // A media element can only ever feed one source node.
      elementSources.set(element, (elementSources.get(element) ?? 0) + 1);
      assert.equal(elementSources.get(element), 1);
      return node('song');
    },
    addEventListener(_: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_: string, listener: () => void) { listeners.delete(listener); },
    close() { this.state = 'closed'; for (const l of [...listeners]) l(); },
    resume: async () => {},
  };
  return context;
}

function fakeElement() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    src: '', preload: '', paused: true, ended: false, currentTime: 0, duration: 200,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    removeAttribute(name: string) { if (name === 'src') this.src = ''; },
    load() {},
    async play() { this.paused = false; this.emit('play'); },
    pause() { this.paused = true; },
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);
    },
    emit(type: string) { for (const l of [...listeners.get(type) ?? []]) l(); },
  };
}

function harness() {
  const elements: ReturnType<typeof fakeElement>[] = [];
  const mix = new LocalFileMix({ createElement: () => { const e = fakeElement(); elements.push(e); return e; } });
  const events: string[] = [];
  mix.addEventListener('change', (event: any) => events.push(event.detail.kind));
  const stream = { getAudioTracks: () => [{ getSettings: () => ({ latency: 0.02 }) }] };
  const capture = (context: ReturnType<typeof fakeContext>) => ({
    context, stream, source: context.createGain(), capture: context.createGain(),
  });
  const file = (name: string) => new File([new Uint8Array(4)], name, { type: 'audio/mpeg' });
  return { mix, events, elements, capture, file };
}

const nodeOf = (context: ReturnType<typeof fakeContext>, kind: string) =>
  context.nodes.filter(n => n.kind === kind);

test('round trip is graph buffer + output + input; unreported parts count as zero', () => {
  assert.equal(roundTripLatencySeconds({ baseLatency: 0.01, outputLatency: 0.03, inputLatency: 0.02 }), 0.06);
  assert.equal(roundTripLatencySeconds({ baseLatency: undefined, outputLatency: NaN, inputLatency: -1 }), 0);
});

test('song delay adds the singer offset and stays within the delay line', () => {
  assert.ok(Math.abs(songDelaySeconds(0.06, 40) - 0.1) < 1e-9);
  assert.equal(songDelaySeconds(0.02, -100), 0);
  assert.equal(songDelaySeconds(1.9, 500), 2);
});

test('without a file the Mic is captured alone', () => {
  const h = harness();
  assert.equal(h.mix.connectInput(h.capture(fakeContext())), null);
  assert.equal(h.mix.active, false);
});

test('an open file routes Mic and the delayed song into one mono capture input', () => {
  const h = harness();
  h.mix.open(h.file('My Song.mp3'));
  assert.equal(h.mix.title, 'My Song');
  assert.deepEqual(h.events, ['mode']);

  const context = fakeContext();
  const input = h.capture(context);
  const handle = h.mix.connectInput(input);
  assert.ok(handle);
  const [song] = nodeOf(context, 'song');
  const [delay] = nodeOf(context, 'delay');
  // The singer hears the song undelayed; the mix gets it after the round trip.
  assert.ok(song.edges.has(context.destination));
  assert.ok(Math.abs(delay.delayTime.value - 0.06) < 1e-9);
  // Mic -> vocal gain, and exactly one node feeds the capture.
  const vocal = [...input.source.edges][0] as FakeNode;
  assert.equal(vocal.kind, 'gain');
  assert.ok(Math.abs(vocal.gain.value - 10 ** (24 / 20)) < 1e-9);
  const feeders = context.nodes.filter(n => n.edges.has(input.capture));
  assert.equal(feeders.length, 1);
  const sum = context.nodes.find(n => n.channelCount === 1 && n.kind === 'gain');
  assert.equal(sum?.channelCountMode, 'explicit');
  assert.equal(h.mix.roundTripMs, 60);

  handle.disconnect();
  assert.equal(input.source.edges.size, 0);
  assert.equal(context.nodes.filter(n => n.edges.has(input.capture)).length, 0);
});

test('the singer offset moves the song delay and is clamped', () => {
  const h = harness();
  h.mix.open(h.file('a.wav'));
  const context = fakeContext({ baseLatency: 0, outputLatency: 0.05 });
  h.mix.connectInput(h.capture(context));
  const [delay] = nodeOf(context, 'delay');
  h.mix.setOffsetMs(30);
  assert.ok(Math.abs(delay.delayTime.value - 0.1) < 1e-9);
  h.mix.setOffsetMs(-10_000);
  assert.equal(h.mix.offsetMs, -500);
  assert.equal(delay.delayTime.value, 0);
});

test('a replacement AudioContext gets a fresh element that resumes where the song was', async () => {
  const h = harness();
  h.mix.open(h.file('a.wav'));
  const first = fakeContext();
  h.mix.connectInput(h.capture(first));
  await h.mix.play();
  h.elements[0].currentTime = 42;

  const second = fakeContext();
  h.mix.connectInput(h.capture(second));
  assert.equal(h.elements.length, 2);
  assert.equal(h.elements[0].paused, true);
  h.elements[1].emit('loadedmetadata');
  assert.equal(h.elements[1].currentTime, 42);
  await Promise.resolve();
  assert.equal(h.elements[1].paused, false);
  h.mix.pause();
});

test('a closed capture context detaches the song until the next Mic capture', async () => {
  const h = harness();
  h.mix.open(h.file('a.wav'));
  const context = fakeContext();
  h.mix.connectInput(h.capture(context));
  assert.equal(h.mix.attached, true);
  context.close();
  assert.equal(h.mix.attached, false);
  assert.ok(h.events.includes('detached'));
  assert.equal(await h.mix.play(), false);
  assert.equal(h.events.at(-1), 'needs-mic');
});

test('a second file replaces the song on the same capture without a mode change', () => {
  const h = harness();
  h.mix.open(h.file('a.wav'));
  const context = fakeContext();
  const input = h.capture(context);
  h.mix.connectInput(input);
  h.events.length = 0;

  h.mix.open(h.file('b.wav'));
  assert.equal(h.events.includes('mode'), false);
  assert.equal(h.elements.length, 2);
  // Still exactly one route into the capture, from the new song graph.
  assert.equal(context.nodes.filter(n => n.edges.has(input.capture)).length, 1);
  assert.equal(input.source.edges.size, 1);
});

test('closing the file unlinks the capture and reports a mode change', () => {
  const h = harness();
  h.mix.open(h.file('a.wav'));
  const context = fakeContext();
  const input = h.capture(context);
  const handle = h.mix.connectInput(input);
  h.events.length = 0;
  h.mix.close();
  assert.deepEqual(h.events, ['mode']);
  assert.equal(h.mix.active, false);
  assert.equal(context.nodes.filter(n => n.edges.has(input.capture)).length, 0);
  // The capture graph's own dispose afterwards is harmless.
  handle?.disconnect();
});

test('a Mic session that ends does not start the song again on the next Mic', async () => {
  const h = harness();
  h.mix.open(h.file('a.wav'));
  const first = fakeContext();
  h.mix.connectInput(h.capture(first));
  await h.mix.play();
  h.elements[0].currentTime = 30;
  first.close();

  h.mix.connectInput(h.capture(fakeContext()));
  h.elements[1].emit('loadedmetadata');
  await Promise.resolve();
  assert.equal(h.elements[1].currentTime, 30, 'the position is kept');
  assert.equal(h.elements[1].paused, true, 'but the singer presses Play');
});

test('the song area follows who holds the Mic', () => {
  const surface = (fileOpen: boolean, micOwnerId: string | null, roomLocalFile: unknown = null) =>
    localFileSurface({ fileOpen, myId: 'me', micOwnerId, roomLocalFile });
  assert.equal(surface(true, 'me'), 'owner');
  assert.equal(surface(true, null), 'owner');
  // A file opened before taking over: the current singer's song stays visible.
  assert.equal(surface(true, 'other'), 'standby');
  assert.equal(surface(false, 'other', { title: 'x' }), 'observer');
  assert.equal(surface(false, 'other'), 'none');
  assert.equal(surface(false, 'me', { title: 'x' }), 'none');
});

test('only a handoff from this phone to another ends its local file', () => {
  const lost = (previousOwnerId: string | null, nextOwnerId: string | null) =>
    lostMicToAnother({ previousOwnerId, nextOwnerId, myId: 'me' });
  assert.equal(lost('me', 'other'), true);
  assert.equal(lost('me', null), false, 'a reconnect grace or a release is not a handoff');
  assert.equal(lost('other', 'me'), false);
  assert.equal(lost('other', 'third'), false);
  assert.equal(lost(null, 'other'), false);
});
