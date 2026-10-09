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
  'timing.blocked.phone-not-playing': '播放歌曲後才能重新對齊',
  'timing.blocked.robot-route-incomplete': 'Robot 音訊路由中斷，重啟後才能重新對齊',
  'timing.blocked.calibration-active': '對齊中…',
};

function harness(options: { selfMic?: 'live' | 'off' } = {}) {
  const windowListeners = new Map<string, Listener[]>();
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

    children = new Map<string, Element>();

    querySelector(selector: string) { return this.children.get(selector) ?? null; }

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

  // index.html's Realign action: the button with its label and value, and
  // the status line below it.
  const button = new Element('calibrate-timing');
  const label = new Element('');
  button.children.set('.calibrate-timing-label', label);
  const value = new Element('timing-active-value');
  const status = new Element('calibrate-status');

  const body = { dataset: { selfMic: options.selfMic ?? 'off' } };
  const document = {
    body,
    querySelector(selector: string) {
      if (selector === '#calibrate-timing') return button;
      if (selector === '#calibrate-status') return status;
      if (selector === '#timing-active-value') return value;
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
    // app.js sends the command when the presenter asks for it.
    dispatchEvent(event: { type: string }) {
      if (event.type === 'relay-start-timing-calibration') commandCount += 1;
      return true;
    },
  };

  class Event {
    type: string;
    constructor(type: string) { this.type = type; }
  }
  class CustomEvent extends Event {}

  runInNewContext(source, {
    window,
    document,
    Event,
    CustomEvent,
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
    button,
    label,
    value,
    status,
    emit,
    emitCommandAuthority,
    emitProductAuthority,
    emitProductStatus,
    commandCount: () => commandCount,
    preflightCommandCount: () => preflightCommandCount,
  };
}

test('calibration presenter paints the Realign markup it is given', () => {
  const ui = harness({ selfMic: 'live' });
  assert.equal(ui.label.textContent, '重新對齊');
  assert.equal(ui.value.textContent, '—', 'no fresh timing authority yet');
  assert.doesNotMatch(source, /cloneNode|replaceWith|MutationObserver/);
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
  assert.equal(ui.label.textContent, '重新對齊');
  // The server said exactly why; repeating a generic "unavailable" would throw
  // that away and leave the user with no idea what to do next.
  assert.equal(ui.status.textContent, '播放歌曲後才能重新對齊');

  ui.emitProductStatus({
    canStartCalibration: true,
    startCalibrationBlockedReason: null,
    startCalibrationMode: 'content',
  });
  assert.equal(ui.label.textContent, '重新對齊');
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
  assert.equal(ui.label.textContent, '重新對齊');
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
    assert.equal(ui.label.textContent, '重新對齊', reason);
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
  assert.equal(ui.label.textContent, '重新對齊');
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
  assert.equal(ui.label.textContent, '重新對齊');
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
  assert.equal(ui.label.textContent, '重新對齊');
  assert.equal(ui.status.textContent, '目前無法重新對齊');
});

test('each refusal says what to do, not just that it will not work', () => {
  const ui = harness({ selfMic: 'live' });

  // A Robot route has no Desktop Source to plug in, so it must not borrow the
  // copy for a transport the user actually owns.
  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'robot-route-incomplete',
    startCalibrationMode: 'boot-probe',
  });
  assert.equal(ui.status.textContent, 'Robot 音訊路由中斷，重啟後才能重新對齊');

  // A reason with no copy yet still degrades to the generic line rather than
  // painting a raw key at the user.
  ui.emitProductStatus({
    canStartCalibration: false,
    startCalibrationBlockedReason: 'sources-not-streaming',
    startCalibrationMode: 'content',
  });
  assert.equal(ui.status.textContent, '目前無法重新對齊');
});

test('a background content run does not flip the button while it retries', () => {
  const ui = harness({ selfMic: 'live' });

  // `timing.state` describes what the room's alignment currently *is*, not
  // whether the action may run. Reading it here made every automatic content
  // retry - and there is one every few seconds when conditions are poor -
  // blink the button between enabled and "Aligning…".
  ui.emitProductStatus(
    {
      canStartCalibration: true,
      startCalibrationBlockedReason: null,
      startCalibrationMode: 'content',
    },
    { state: 'calibrating' },
  );

  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.status.textContent, '');
});

test('the audible boot probe still shows the room as aligning', () => {
  const ui = harness({ selfMic: 'live' });
  ui.emitProductStatus(
    {
      canStartCalibration: false,
      startCalibrationBlockedReason: 'calibration-active',
      startCalibrationMode: 'boot-probe',
    },
    { state: 'calibrating' },
  );

  assert.equal(ui.button.disabled, true);
  assert.equal(ui.status.textContent, '對齊中…');
});
