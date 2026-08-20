import assert from 'node:assert/strict';
import test from 'node:test';

type Listener = (event: any) => void;

class FakeTarget {
  open = false;
  hidden = false;
  dataset: Record<string, string> = {};
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatch(type: string, detail: Record<string, unknown> = {}) {
    const event = { type, target: this, detail, key: detail.key };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click() {
    this.dispatch('click');
  }

  focus() {}
  removeAttribute() {}
  querySelector(_selector: string): FakeTarget | null { return null; }
  querySelectorAll(_selector: string): FakeTarget[] { return []; }
}

class FakeDocument extends FakeTarget {
  body = { dataset: {} as Record<string, string> };
  nodes = new Map<string, FakeTarget>();

  override querySelector(selector: string): FakeTarget | null {
    return this.nodes.get(selector) ?? null;
  }
}

class FakeWindow extends FakeTarget {}

test('System click opens the secondary sheet at runtime', async () => {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const openSystem = new FakeTarget();
  const closeSystem = new FakeTarget();
  const systemPanel = new FakeTarget();
  const moreMenu = new FakeTarget();
  moreMenu.open = true;

  document.nodes.set('#open-system', openSystem);
  document.nodes.set('#close-system', closeSystem);
  document.nodes.set('#system-panel', systemPanel);
  document.nodes.set('#room-more', moreMenu);

  const globals = globalThis as any;
  const previous = {
    document: globals.document,
    window: globals.window,
    requestAnimationFrame: globals.requestAnimationFrame,
  };

  globals.document = document;
  globals.window = window;
  globals.requestAnimationFrame = (callback: (timestamp: number) => void) => {
    callback(0);
    return 1;
  };

  try {
    const moduleUrl = new URL('../public/live-ia.js', import.meta.url);
    moduleUrl.searchParams.set('runtime-test', `${Date.now()}-${Math.random()}`);
    await import(moduleUrl.href);

    assert.equal(systemPanel.open, false);
    openSystem.click();
    assert.equal(systemPanel.open, true);
    assert.equal(moreMenu.open, false);

    closeSystem.click();
    assert.equal(systemPanel.open, false);

    // Give contained optional presenter imports a chance to settle while the
    // fake browser globals are still installed. They intentionally find no UI
    // roots in this harness and therefore cannot affect secondary navigation.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    globals.document = previous.document;
    globals.window = previous.window;
    globals.requestAnimationFrame = previous.requestAnimationFrame;
  }
});
