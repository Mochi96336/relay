import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');

type Listener = (event: { detail?: unknown }) => void;

function harness(options: {
  hidden?: boolean;
  disabled?: boolean;
  status?: string;
  selfMic?: 'live' | 'off';
} = {}) {
  const listeners = new Map<string, Listener[]>();
  const microtasks: Array<() => void> = [];
  const button = {
    hidden: options.hidden ?? true,
    disabled: options.disabled ?? true,
    textContent: 'Recalibrate',
    removeAttribute() {},
  };
  const status = {
    textContent: options.status ?? 'legacy status',
  };
  const body = {
    dataset: { selfMic: options.selfMic ?? 'off' },
  };

  const window = {
    relayI18n: { getLocale: () => 'zh-Hant' },
    addEventListener(type: string, listener: Listener) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
  };

  const document = {
    body,
    querySelector(selector: string) {
      if (selector === '#calibrate-timing') return button;
      if (selector === '#calibrate-status') return status;
      return null;
    },
  };

  class MutationObserver {
    constructor(_callback: () => void) {}
    observe() {}
  }

  runInNewContext(source, {
    window,
    document,
    MutationObserver,
    queueMicrotask(callback: () => void) {
      microtasks.push(callback);
    },
  });

  function flush() {
    while (microtasks.length > 0) microtasks.shift()?.();
  }

  function emitProductStatus(actions: Record<string, unknown>) {
    for (const listener of listeners.get('relay-product-status') ?? []) {
      listener({ detail: { actions } });
    }
    flush();
  }

  return { button, status, body, emitProductStatus };
}

test('content mode is relabelled without stealing its visibility or eligibility', () => {
  const ui = harness({ hidden: true, disabled: true, status: 'content status', selfMic: 'live' });

  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'phone-not-playing',
    startCalibrationMode: 'content',
  });

  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.status.textContent, 'content status');
});

test('Robot ready ignores Song-era button state when this phone owns the Mic', () => {
  const ui = harness({ hidden: true, disabled: true, status: 'No song to align.', selfMic: 'live' });

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

test('healthy Robot timing does not leave a disabled recovery action for a non-owner phone', () => {
  const ui = harness({ hidden: false, disabled: false, selfMic: 'off' });

  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });

  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '重新對齊');
});

test('every Robot capture-path prerequisite projects as preparing audio paths', () => {
  for (const reason of ['sources-not-ready', 'sources-not-connected', 'sources-not-streaming']) {
    const ui = harness({ hidden: false, disabled: false, status: 'No song to align.', selfMic: 'live' });

    ui.emitProductStatus({
      canStartCalibration: false,
      startCalibrationBlockedReason: reason,
      startCalibrationMode: 'boot-probe',
    });

    assert.equal(ui.button.hidden, true, reason);
    assert.equal(ui.button.disabled, true, reason);
    assert.equal(ui.button.textContent, '重新對齊', reason);
    assert.equal(ui.status.textContent, '正在準備聲音路徑…', reason);
  }
});

test('active Robot probe is visible as aligning and cannot be started twice', () => {
  const ui = harness({ hidden: true, disabled: false, selfMic: 'live' });

  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'calibration-active',
    startCalibrationMode: 'boot-probe',
  });

  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '對齊中…');
  assert.equal(ui.status.textContent, '對齊中…');
});

test('unknown Robot blocks do not invent visibility or eligibility semantics', () => {
  const ui = harness({ hidden: true, disabled: true, status: 'owned elsewhere', selfMic: 'live' });

  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'take-active',
    startCalibrationMode: 'boot-probe',
  });

  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.status.textContent, 'owned elsewhere');
});
