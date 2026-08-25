import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');

function runtime() {
  const document = {
    documentElement: { lang: '' },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  };
  const navigator = { languages: ['en'], language: 'en' };
  const window = { dispatchEvent: () => true } as any;
  class CustomEvent {
    constructor(public type: string, public init: any) {}
  }

  runInNewContext(source, { window, document, localStorage, navigator, CustomEvent });
  return window.relayI18n;
}

test('registered feature messages use the base provider lookup and locale fallback', () => {
  const i18n = runtime();
  assert.equal(typeof i18n.registerMessages, 'function');

  assert.equal(i18n.registerMessages({
    en: { 'feature.greeting': 'Hello {name}' },
    'zh-Hant': { 'feature.greeting': '你好，{name}' },
  }), true);

  assert.equal(i18n.has('feature.greeting'), true);
  assert.equal(i18n.t('feature.greeting', { name: 'Mochi' }), 'Hello Mochi');
  assert.equal(i18n.setLocale('zh-Hant', { persist: false }), true);
  assert.equal(i18n.t('feature.greeting', { name: 'Mochi' }), '你好，Mochi');
});

test('message registration cannot silently take ownership from an existing provider key', () => {
  const i18n = runtime();

  assert.equal(i18n.registerMessages({ en: { 'mic.take': 'Take Mic' } }), false,
    'registering the identical existing value is an idempotent no-op');
  assert.throws(
    () => i18n.registerMessages({ en: { 'mic.take': 'Different copy' } }),
    /Relay i18n key already registered: en:mic\.take/,
  );
  assert.equal(i18n.t('mic.take'), 'Take Mic');
});

test('a conflicting message bundle is rejected atomically', () => {
  const i18n = runtime();

  assert.throws(
    () => i18n.registerMessages({
      en: { 'feature.partial': 'Must not stick' },
      'zh-Hant': { 'mic.take': '不同文案' },
    }),
    /Relay i18n key already registered: zh-Hant:mic\.take/,
  );

  assert.equal(i18n.has('feature.partial'), false,
    'a later conflict must not leave earlier locale additions registered');
  assert.equal(i18n.t('mic.take'), 'Take Mic');
});

test('normalized locale aliases cannot race to own the same staged key', () => {
  const i18n = runtime();

  assert.throws(
    () => i18n.registerMessages({
      en: { 'feature.alias': 'First owner' },
      'en-US': { 'feature.alias': 'Second owner' },
    }),
    /Relay i18n key already registered: en:feature\.alias/,
  );
  assert.equal(i18n.has('feature.alias'), false,
    'conflicting aliases must not commit either staged value');

  assert.equal(i18n.registerMessages({
    en: { 'feature.alias': 'Same owner' },
    'en-US': { 'feature.alias': 'Same owner' },
  }), true,
    'identical aliases collapse to one staged registration');
  assert.equal(i18n.t('feature.alias'), 'Same owner');
});
