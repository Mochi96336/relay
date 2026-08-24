import assert from 'node:assert/strict';
import test from 'node:test';

class FakeDocument {
  elements: FakeElement[] = [];

  add(element: FakeElement) {
    element.ownerDocument = this;
    this.elements.push(element);
    return element;
  }

  replace(current: FakeElement, replacement: FakeElement) {
    const index = this.elements.indexOf(current);
    assert.notEqual(index, -1, 'replacement target must still be attached');
    current.ownerDocument = null;
    replacement.ownerDocument = this;
    this.elements[index] = replacement;
  }

  querySelector(selector: string) {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      return this.elements.find((element) => element.id === id) ?? null;
    }
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return this.elements.find((element) => element.className.split(/\s+/).includes(className)) ?? null;
    }
    return null;
  }
}

class FakeElement extends EventTarget {
  ownerDocument: FakeDocument | null = null;
  id: string;
  className: string;
  textContent: string;
  hidden = false;
  disabled = false;
  tabIndex = 0;
  attributes = new Map<string, string>();

  constructor({
    id = '',
    className = '',
    textContent = '',
    attributes = {},
  }: {
    id?: string;
    className?: string;
    textContent?: string;
    attributes?: Record<string, string>;
  } = {}) {
    super();
    this.id = id;
    this.className = className;
    this.textContent = textContent;
    for (const [key, value] of Object.entries(attributes)) this.attributes.set(key, value);
  }

  cloneNode() {
    const clone = new FakeElement({
      id: this.id,
      className: this.className,
      textContent: this.textContent,
      attributes: Object.fromEntries(this.attributes),
    });
    clone.hidden = this.hidden;
    clone.disabled = this.disabled;
    clone.tabIndex = this.tabIndex;
    return clone;
  }

  replaceWith(replacement: FakeElement) {
    this.ownerDocument?.replace(this, replacement);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

function detailEvent(type: string, detail: unknown) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

test('calibration presenter keeps one visible owner across blocked, active, locale, and actionable states', async () => {
  const previousWindow = (globalThis as any).window;
  const previousDocument = (globalThis as any).document;

  const document = new FakeDocument();
  const legacyButton = document.add(new FakeElement({
    id: 'calibrate-timing',
    textContent: 'Recalibrate',
    attributes: { 'data-i18n': 'adjust.recalibrate' },
  }));
  document.add(new FakeElement({ id: 'calibrate-status' }));
  const fineTune = document.add(new FakeElement({ className: 'more-timing' }));

  let forwardedClicks = 0;
  legacyButton.addEventListener('click', () => { forwardedClicks += 1; });

  let locale: 'en' | 'zh-Hant' = 'en';
  const messages = {
    en: {
      'timing.realign': 'Realign',
      'timing.aligning': 'Aligning…',
      'timing.unavailable': 'Unable to realign right now',
      'timing.reconnecting': 'Reconnecting…',
    },
    'zh-Hant': {
      'timing.realign': '重新對齊',
      'timing.aligning': '對齊中…',
      'timing.unavailable': '目前無法重新對齊',
      'timing.reconnecting': '重新連線中…',
    },
  } as const;

  const window = new EventTarget() as EventTarget & Record<string, any>;
  window.relayParticipantId = 'self';
  window.relayI18n = {
    t(key: keyof typeof messages.en) {
      return messages[locale][key] ?? key;
    },
  };
  window.relayProductAuthority = {
    authorityFresh: false,
    lastKnownSnapshot: null,
  };
  window.relayCommandAuthority = {
    commandChannelFresh: true,
  };

  (globalThis as any).window = window;
  (globalThis as any).document = document;

  try {
    const moduleUrl = new URL('../public/calibration-ui.js', import.meta.url);
    moduleUrl.searchParams.set('lifecycle-test', String(Date.now()));
    await import(moduleUrl.href);

    const visibleButton = document.querySelector('#calibrate-timing');
    const visibleStatus = document.querySelector('#calibrate-status');
    assert.ok(visibleButton && visibleStatus);
    assert.notEqual(visibleButton, legacyButton,
      'presenter must replace the app-captured command node instead of sharing it');
    assert.equal(document.elements.includes(legacyButton), false,
      'command transport node must be detached from painted DOM');
    assert.equal(legacyButton.hidden, true);
    assert.equal(legacyButton.id, 'calibrate-timing-command');
    assert.equal(fineTune.hidden, true);
    assert.equal(fineTune.getAttribute('aria-hidden'), 'true');

    window.dispatchEvent(detailEvent('relay-product-status', {
      type: 'product-status',
      room: { mic: { ownerId: 'self' } },
      actions: {
        canStartCalibration: false,
        startCalibrationBlockedReason: 'sources-not-streaming',
        startCalibrationMode: 'boot-probe',
      },
      timing: { state: 'aligned' },
    }));

    assert.equal(visibleButton.hidden, false);
    assert.equal(visibleButton.disabled, true);
    assert.equal(visibleButton.textContent, 'Realign');
    assert.equal(visibleStatus.textContent, 'Unable to realign right now',
      'a server-blocked action must not masquerade as active calibration');

    window.dispatchEvent(detailEvent('relay-product-status', {
      type: 'product-status',
      room: { mic: { ownerId: 'self' } },
      actions: {
        canStartCalibration: false,
        startCalibrationBlockedReason: 'calibration-active',
        startCalibrationMode: 'content',
      },
      timing: { state: 'calibrating' },
    }));

    assert.equal(visibleButton.hidden, false);
    assert.equal(visibleButton.disabled, true);
    assert.equal(visibleButton.textContent, 'Realign');
    assert.equal(visibleStatus.textContent, 'Aligning…');
    assert.equal(document.elements.filter((element) => element.id === 'calibrate-timing').length, 1);

    locale = 'zh-Hant';
    window.dispatchEvent(new Event('relay-locale-changed'));

    assert.equal(document.querySelector('#calibrate-timing'), visibleButton,
      'locale changes must rerender the same visible presenter');
    assert.equal(visibleButton.textContent, '重新對齊');
    assert.equal(visibleStatus.textContent, '對齊中…');
    assert.equal(document.elements.filter((element) => element.id === 'calibrate-timing').length, 1,
      'locale switching must never revive the legacy command node');

    window.dispatchEvent(detailEvent('relay-product-status', {
      type: 'product-status',
      room: { mic: { ownerId: 'self' } },
      actions: {
        canStartCalibration: true,
        startCalibrationBlockedReason: null,
        startCalibrationMode: 'boot-probe',
      },
      timing: { state: 'aligned' },
    }));

    assert.equal(visibleButton.hidden, false);
    assert.equal(visibleButton.disabled, false);
    visibleButton.dispatchEvent(new Event('click', { cancelable: true }));
    assert.equal(forwardedClicks, 1,
      'the sole visible presenter must forward the user action to the detached authenticated transport');
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
  }
});
