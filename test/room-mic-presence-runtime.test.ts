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

test('a higher note draws denser ripples along the band; an unpitched one draws none', async () => {
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

  // Ripples on the band's upper edge: local tops of the path's anchor points.
  const ripples = () => {
    const d = meter.querySelector('.voice-presence-wave')!.attributes.get('d') ?? '';
    const ys = [...d.matchAll(/(?:M|, ) ?(-?[\d.]+) (-?[\d.]+)(?= C| L| Z|$)/g)]
      .map((match) => Number(match[2]))
      .filter((y) => y < 28);
    // A top is where the edge turns from rising (y falling) to falling,
    // ignoring steps too small to see.
    let tops = 0;
    let rising: boolean | null = null;
    let anchor = ys[0];
    for (const y of ys.slice(1)) {
      if (Math.abs(y - anchor) < 0.3) continue;
      const nowRising = y < anchor;
      if (rising === true && !nowRising) tops += 1;
      rising = nowRising;
      anchor = y;
    }
    return tops;
  };
  const steady = (f0Hz: number | null, pitchConfidence: number) => {
    for (let i = 0; i < 24; i += 1) {
      fakeWindow.emit('relay-room-mic-presence', { ...presenceFrame('owner-a', 1), f0Hz, pitchConfidence });
    }
    return ripples();
  };

  try {
    const moduleUrl = new URL('../public/mic-presence.js', import.meta.url);
    moduleUrl.searchParams.set('runtime-test', `${Date.now()}-${Math.random()}`);
    await import(moduleUrl.href);

    assert.equal(steady(null, 0), 0, 'no pitch: a smooth edge');
    const low = steady(130.8, 0.95);
    const high = steady(523.3, 0.95);
    // Both halves together: about 2 x 4.4 ripples at C3 and 2 x 14 at C5.
    assert.ok(low >= 7 && low <= 12, `C3 draws about nine ripples (${low})`);
    assert.ok(high >= 24, `C5 draws about twenty-eight ripples, every one visible (${high})`);
  } finally {
    globals.window = previous.window;
    globals.document = previous.document;
  }
});
