import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const base = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const live = readFileSync(new URL('../public/live-i18n.js', import.meta.url), 'utf8');
const actions = readFileSync(new URL('../public/mic-actions.js', import.meta.url), 'utf8');

const actionKeys = [
  'mic.cancel',
  'mic.release',
  'mic.startFailed',
  'mic.take',
  'mic.takeover',
  'mic.takeoverChanged',
  'mic.takeoverChangedOwner',
  'mic.takeoverPending',
  'mic.takeoverPrompt',
];

function countKey(source: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`'${escaped}':`, 'g'))?.length ?? 0;
}

test('base i18n is the only Mic product-copy authority', () => {
  for (const key of ['mic.label', ...actionKeys]) {
    assert.equal(countKey(base, key), 2, `${key} must exist once per base locale`);
  }

  assert.doesNotMatch(live, /'mic\.[^']+'\s*:/,
    'Live i18n must not override Mic product copy');

  for (const deadKey of ['mic.microphone', 'mic.takeoverPreparing', 'mic.takeoverKept']) {
    assert.equal(countKey(base, deadKey), 0, `${deadKey} is retired vocabulary`);
    assert.doesNotMatch(actions, new RegExp(deadKey.replaceAll('.', '\\.')),
      `${deadKey} must not regain a presenter consumer`);
  }
});

test('Mic presenter keys are exactly the base-owned action vocabulary', () => {
  const presenterKeys = [...actions.matchAll(/t\('(mic\.[^']+)'/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(presenterKeys)].sort(), [...actionKeys].sort());

  assert.match(base, /'mic\.take': 'Take Mic'/);
  assert.match(base, /'mic\.release': 'Release Mic'/);
  assert.match(base, /'mic\.takeover': 'Take over Mic'/);
  assert.match(base, /'mic\.takeoverPrompt': '\{name\} is using Mic\.'/);
  assert.match(base, /'mic\.take': '拿 Mic'/);
  assert.match(base, /'mic\.release': '放 Mic'/);
  assert.match(base, /'mic\.takeover': '接手 Mic'/);
  assert.match(base, /'mic\.takeoverPrompt': '目前是 \{name\} 在使用 Mic。'/);
});
