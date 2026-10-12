import assert from 'node:assert/strict';
import test from 'node:test';

type Listener = (event: { type: string; detail?: any }) => void;

class FakeWindow {
  relayProductAuthority: any = null;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: { type: string; detail?: any }) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }

  emit(type: string, detail: any) {
    this.dispatchEvent({ type, detail });
  }
}

class FakeSvgNode {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { add() {} };
  children: FakeSvgNode[] = [];

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  append(...nodes: FakeSvgNode[]) {
    this.children.push(...nodes);
  }

  /** The meter's waveform path, painted by index.html. */
  querySelector(selector: string): FakeSvgNode | null {
    if (selector !== '.voice-presence-wave') return null;
    this.children[0] ??= new FakeSvgNode();
    return this.children[0];
  }
}

function presenceFrame(ownerId: string, generation: number) {
  return {
    active: true,
    ownerId,
    captureGeneration: generation,
    rmsDbfs: -24,
    spectrumBands: [0.2, 0.3, 0.4, 0.3, 0.2],
    f0Hz: 220,
    pitchConfidence: 0.9,
  };
}

test('late Room Mic frame cannot revive a superseded owner waveform or surface', async () => {
  const fakeWindow = new FakeWindow();
  const meter = new FakeSvgNode();
  const body = { dataset: {} as Record<string, string> };
  fakeWindow.relayProductAuthority = {
    authorityFresh: true,
    lastKnownSnapshot: {
      room: { mic: { state: 'live', ownerId: 'owner-a' } },
    },
  };

  const fakeDocument = {
    body,
    querySelector(selector: string) {
      return selector === '#mic-input-meter' ? meter : null;
    },
  };

  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document };
  globals.window = fakeWindow;
  globals.document = fakeDocument;

  try {
    const moduleUrl = new URL('../public/mic-presence.js', import.meta.url);
    moduleUrl.searchParams.set('runtime-test', `${Date.now()}-${Math.random()}`);
    await import(moduleUrl.href);

    fakeWindow.emit('relay-room-mic-presence', presenceFrame('owner-a', 1));
    assert.equal(meter.dataset.active, 'true');
    assert.equal(body.dataset.roomMic, 'live');

    fakeWindow.emit('relay-product-authority', {
      authorityFresh: true,
      lastKnownSnapshot: {
        room: { mic: { state: 'live', ownerId: 'owner-b' } },
      },
    });
    assert.equal(meter.dataset.active, 'false', 'owner transition clears the old tail');

    fakeWindow.emit('relay-room-mic-presence', presenceFrame('owner-a', 1));
    assert.equal(
      meter.dataset.active,
      'false',
      'a late frame from the old authoritative owner must stay rejected',
    );
    assert.equal(body.dataset.roomMic, 'live', 'current owner B is still authoritatively live');

    fakeWindow.emit('relay-room-mic-presence', presenceFrame('owner-b', 2));
    assert.equal(meter.dataset.active, 'true');

    fakeWindow.emit('relay-product-authority', {
      authorityFresh: true,
      lastKnownSnapshot: {
        room: { mic: { state: 'free', ownerId: null } },
      },
    });
    assert.equal(meter.dataset.active, 'false');
    assert.equal(body.dataset.roomMic, 'off');

    // Model an upstream late-frame adapter momentarily asserting live before
    // this sole waveform presenter receives the same stale frame. The product
    // authority must win synchronously, so the normal surface stays absent.
    body.dataset.roomMic = 'live';
    fakeWindow.emit('relay-room-mic-presence', presenceFrame('owner-b', 2));
    assert.equal(meter.dataset.active, 'false');
    assert.equal(body.dataset.roomMic, 'off');

    fakeWindow.emit('relay-product-authority', {
      authorityFresh: false,
      lastKnownSnapshot: {
        room: { mic: { state: 'live', ownerId: 'owner-b' } },
      },
    });
    assert.equal(meter.dataset.active, 'false', 'stale room authority clears visible evidence');
    assert.equal(body.dataset.roomMic, 'off');
  } finally {
    globals.window = previous.window;
    globals.document = previous.document;
  }
});

test('a note above the singer\'s recent pitch lifts the band; an unpitched one leaves it centred', async () => {
  const fakeWindow = new FakeWindow();
  const meter = new FakeSvgNode();
  fakeWindow.relayProductAuthority = {
    authorityFresh: true,
    lastKnownSnapshot: { room: { mic: { state: 'live', ownerId: 'owner-a' } } },
  };
  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document };
  globals.window = fakeWindow;
  globals.document = { body: { dataset: {} }, querySelector: (s: string) => (s === '#mic-input-meter' ? meter : null) };

  // How far the newest slice, drawn at the centre (x = 160), reaches above
  // and below the centre line (y = 28): the path's two anchors at x = 160.
  const reach = () => {
    const d = meter.querySelector('.voice-presence-wave')!.attributes.get('d') ?? '';
    const anchors = [...d.matchAll(/(?:M|, |L) ?(-?[\d.]+) (-?[\d.]+)(?= C| L| Z|$)/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))
      .filter((point) => Math.abs(point.x - 160) < 0.01)
      .map((point) => point.y);
    assert.equal(anchors.length, 2, d);
    return { above: 28 - Math.min(...anchors), below: Math.max(...anchors) - 28 };
  };
  const frame = (f0Hz: number | null, pitchConfidence: number) => ({
    ...presenceFrame('owner-a', 1), f0Hz, pitchConfidence,
  });

  try {
    const moduleUrl = new URL('../public/mic-presence.js', import.meta.url);
    moduleUrl.searchParams.set('runtime-test', `${Date.now()}-${Math.random()}`);
    await import(moduleUrl.href);

    for (let i = 0; i < 6; i += 1) fakeWindow.emit('relay-room-mic-presence', frame(null, 0));
    const flat = reach();
    assert.ok(Math.abs(flat.above - flat.below) < 0.01, 'no pitch: symmetric about the centre');

    for (let i = 0; i < 6; i += 1) fakeWindow.emit('relay-room-mic-presence', frame(130.8, 0.95));
    fakeWindow.emit('relay-room-mic-presence', frame(261.6, 0.95));
    const high = reach();
    assert.ok(high.above - high.below > 10, `an octave up lifts the band (above ${high.above}, below ${high.below})`);
    assert.ok(high.above <= 27 && high.below <= 27, 'still inside the meter');
  } finally {
    globals.window = previous.window;
    globals.document = previous.document;
  }
});
