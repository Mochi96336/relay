import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { authorityState } from '../public/authority-freshness.js';
import { formatTimingValueMs } from '../public/timing-value.js';

const source = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '');

type Listener = (event: { detail?: any }) => void;

const copy: Record<string, string> = {
  'timing.label': '時間對齊',
  'timing.realign': '重新對齊',
  'timing.aligning': '對齊中…',
  'timing.unavailable': '目前無法重新對齊',
  'timing.reconnecting': '重新連線中…',
};

function harness(options: { selfMic?: 'live' | 'off' } = {}) {
  const windowListeners = new Map<string, Listener[]>();
  let visibleButton: any = null;
  let visibleStatus: any = null;
  let commandCount = 0;
  let preflightCommandCount = 0;

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
    relayI18n: { t: (key: string) => copy[key] ?? key },
    relayParticipantId: 'self',
    relayProductAuthority: null as any,
    relayTimingAuthority: null as any,
    relayCommandAuthority: null as any,
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

  runInNewContext(source, {
    window,
    document,
    Event,
    authorityState,
    formatTimingValueMs,
    sendPreflightCalibrationCommand: () => {
      preflightCommandCount += 1;
      return Promise.resolve();
    },
  });

  function emit(type: string, detail: any) {
    for (const listener of windowListeners.get(type) ?? []) listener({ detail });
  }

  function emitCommandAuthority(fresh: boolean) {
    emit('relay-command-authority', authorityState({
      authorityFresh: fresh,
      lastKnownSnapshot: { registered: true },
      commandChannelFresh: fresh,
      authorized: true,
      serverAllowed: true,
    }));
  }

  function emitProductAuthority(fresh: boolean, snapshot: any) {
    emit('relay-product-authority', authorityState({
      authorityFresh: fresh,
      lastKnownSnapshot: snapshot,
    }));
  }

  function emitProductStatus(
    actions: Record<string, unknown>,
    timing: Record<string, unknown> = { state: 'idle' },
    ownerId: string | null = options.selfMic === 'live' ? 'self' : 'other',
    videoId: string | null = 'abcdefghijk',
  ) {
    const detail = {
      type: 'product-status',
      actions,
      timing,
      room: {
        mic: { ownerId, state: ownerId ? 'live' : 'free' },
        song: { videoId },
      },
    };
    emitCommandAuthority(true);
    emit('relay-product-status', detail);
    return detail;
  }

  return {
    legacyButton,
    legacyStatus,
    get button() { return visibleButton; },
    get status() { return visibleStatus; },
    emit,
    emitCommandAuthority,
    emitProductAuthority,
    emitProductStatus,
    commandCount: () => commandCount,
    preflightCommandCount: () => preflightCommandCount,
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

test('content calibration availability comes from fresh ProductStatus authority', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'phone-not-playing',
    startCalibrationMode: 'content',
  });
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.status.textContent, '目前無法重新對齊');

  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'content',
  });
  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.status.textContent, '');
});

test('local Mic state cannot impersonate server ownership', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  }, { state: 'idle' }, 'another-participant');
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
});

test('Robot ready follows server calibration authority', () => {
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

test('non-owner phone never gets a disabled recovery action', () => {
  const ui = harness({ selfMic: 'off' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.disabled, true);
});

test('technical block reasons collapse to the normal unavailable consequence', () => {
  for (const reason of ['sources-not-connected', 'sources-not-streaming']) {
    const ui = harness({ selfMic: 'live' });
    ui.emitProductStatus({
      canStartCalibration: false,
      startCalibrationBlockedReason: reason,
      startCalibrationMode: 'boot-probe',
    });
    assert.equal(ui.button.hidden, false, reason);
    assert.equal(ui.button.disabled, true, reason);
    assert.equal(ui.button.textContent, '重新對齊', reason);
    assert.equal(ui.status.textContent, '目前無法重新對齊', reason);
  }
});

test('active calibration keeps the action label stable and presents aligning separately', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'calibration-active',
    startCalibrationMode: 'boot-probe',
  }, { state: 'calibrating' });
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.status.textContent, '對齊中…');
});

test('last-known calibration stays visible but non-actionable while ProductStatus is stale', () => {
  const ui = harness({ selfMic: 'live' });
  const snapshot = ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });
  assert.equal(ui.button.disabled, false);

  ui.emitProductAuthority(false, snapshot);
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.status.textContent, '重新連線中…');
  ui.button.click();
  assert.equal(ui.commandCount(), 0);
});

test('stale command transport is non-actionable', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });
  ui.emitCommandAuthority(false);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.status.textContent, '重新連線中…');
  ui.button.click();
  assert.equal(ui.commandCount(), 0);
});

test('visible Song calibration click reaches the already-installed authenticated command transport', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });
  ui.button.click();
  assert.equal(ui.commandCount(), 1);
  assert.equal(ui.preflightCommandCount(), 0);
  assert.equal(ui.button.disabled, false,
    'presenter must not fake a running result before ProductStatus changes');

  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'calibration-active',
    startCalibrationMode: 'boot-probe',
  }, { state: 'calibrating' });
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.status.textContent, '對齊中…');
});

test('no-Song Robot preflight uses the dedicated authenticated command path exactly once', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  }, { state: 'idle' }, 'self', null);

  ui.button.click();
  assert.equal(ui.commandCount(), 0);
  assert.equal(ui.preflightCommandCount(), 1);
});

test('calibration command rejection stays product-generic', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'boot-probe',
  });
  ui.emit('relay-calibration-command-rejected', { reason: 'take-active' });
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.textContent, '重新對齊');
  assert.equal(ui.status.textContent, '目前無法重新對齊');
});
