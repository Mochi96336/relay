import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');

type Listener = (event: { detail?: any }) => void;

function harness(options: { selfMic?: 'live' | 'off' } = {}) {
  const windowListeners = new Map<string, Listener[]>();
  let visibleButton: any = null;
  let visibleStatus: any = null;
  let commandCount = 0;

  class Element {
    id: string;
    hidden = false;
    disabled = false;
    textContent = '';
    tabIndex = 0;
    attributes = new Map<string, string>();
    listeners = new Map<string, Array<(event: any) => void>>();

    constructor(id: string) { this.id = id; }

    cloneNode() {
      const clone = new Element(this.id);
      clone.hidden = this.hidden;
      clone.disabled = this.disabled;
      clone.textContent = this.textContent;
      clone.tabIndex = this.tabIndex;
      clone.attributes = new Map(this.attributes);
      return clone;
    }

    replaceWith(replacement: Element) {
      if (this === legacyButton) visibleButton = replacement;
      if (this === legacyStatus) visibleStatus = replacement;
    }

    addEventListener(type: string, listener: (event: any) => void) {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    dispatchEvent(event: any) {
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
      return true;
    }

    click() {
      if (this.disabled) return;
      this.dispatchEvent({ type: 'click' });
    }

    removeAttribute(name: string) { this.attributes.delete(name); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  }

  const legacyButton = new Element('calibrate-timing');
  legacyButton.textContent = 'Recalibrate';
  legacyButton.attributes.set('data-i18n', 'adjust.recalibrate');
  legacyButton.addEventListener('click', () => { commandCount += 1; });
  const legacyStatus = new Element('calibrate-status');
  legacyStatus.textContent = 'legacy status';

  const body = { dataset: { selfMic: options.selfMic ?? 'off' } };
  const document = {
    body,
    querySelector(selector: string) {
      if (selector === '#calibrate-timing') return legacyButton;
      if (selector === '#calibrate-status') return legacyStatus;
      return null;
    },
  };

  const window = {
    relayI18n: { getLocale: () => 'zh-Hant' },
    addEventListener(type: string, listener: Listener) {
      const current = windowListeners.get(type) ?? [];
      current.push(listener);
      windowListeners.set(type, current);
    },
  };

  class Event {
    type: string;
    constructor(type: string) { this.type = type; }
  }

  runInNewContext(source, { window, document, Event });

  function emit(type: string, detail: any) {
    for (const listener of windowListeners.get(type) ?? []) listener({ detail });
  }

  function emitProductStatus(actions: Record<string, unknown>, timing: Record<string, unknown> = { state: 'idle' }) {
    emit('relay-product-status', { actions, timing });
  }

  return {
    legacyButton,
    legacyStatus,
    get button() { return visibleButton; },
    get status() { return visibleStatus; },
    body,
    emit,
    emitProductStatus,
    commandCount: () => commandCount,
  };
}

test('calibration presenter replaces painted legacy nodes instead of racing them', () => {
  const ui = harness({ selfMic: 'live' });
  assert.ok(ui.button, 'visible calibration button should be a replacement node');
  assert.ok(ui.status, 'visible calibration status should be a replacement node');
  assert.notEqual(ui.button, ui.legacyButton);
  assert.notEqual(ui.status, ui.legacyStatus);
  assert.equal(ui.legacyButton.id, 'calibrate-timing-command');
  assert.equal(ui.legacyStatus.id, 'calibrate-status-command');
  assert.equal(ui.legacyButton.hidden, true);
  assert.equal(ui.legacyStatus.hidden, true);
  assert.doesNotMatch(source, /MutationObserver/);
});

test('content calibration availability comes from ProductStatus, not Song DOM inference', () => {
  const ui = harness({ selfMic: 'live' });

  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'phone-not-playing',
    startCalibrationMode: 'content',
  });
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.status.textContent, '');

  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'content',
  });
  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, false);
});

test('Robot ready ignores Song-era state when this phone owns the Mic', () => {
  const ui = harness({ selfMic: 'live' });

  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });

  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.status.textContent, '');
});

test('healthy calibration does not leave a disabled recovery action for a non-owner phone', () => {
  const ui = harness({ selfMic: 'off' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
});

test('Robot capture-path blocks project as preparing audio paths only for the singer', () => {
  for (const reason of ['sources-not-connected', 'sources-not-streaming']) {
    const ui = harness({ selfMic: 'live' });
    ui.emitProductStatus({
      canStartCalibration: false,
      startCalibrationBlockedReason: reason,
      startCalibrationMode: 'boot-probe',
    });
    assert.equal(ui.button.hidden, true, reason);
    assert.equal(ui.button.disabled, true, reason);
    assert.equal(ui.status.textContent, '正在準備聲音路徑…', reason);
  }
});

test('active calibration is visible as aligning and cannot be started twice', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'calibration-active',
    startCalibrationMode: 'boot-probe',
  }, { state: 'calibrating' });
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '對齊中…');
  assert.equal(ui.status.textContent, '對齊中…');
});

test('a real visible click reaches the installed command transport and waits for server state', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });

  assert.equal(ui.commandCount(), 0);
  ui.button.click();
  assert.equal(ui.commandCount(), 1);
  assert.equal(ui.button.disabled, false,
    'presenter must not fake a running result before ProductStatus changes');

  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'calibration-active',
    startCalibrationMode: 'boot-probe',
  }, { state: 'calibrating' });
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '對齊中…');
});
