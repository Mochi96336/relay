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

  replaceChildren(...nodes: FakeSvgNode[]) {
    this.children = [...nodes];
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
    createElementNS() {
      return new FakeSvgNode();
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
