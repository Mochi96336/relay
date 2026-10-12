import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LISTEN_VOLUME_KEY,
  MIC_GAIN_KEY,
  storeNumber,
  storedNumber,
} from '../public/device-preferences.js';

function withStorage(storage: unknown, run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as any).localStorage;
  }
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test('a device volume survives a reload and is clamped to its control range', () => {
  withStorage(memoryStorage(), () => {
    assert.equal(storedNumber(LISTEN_VOLUME_KEY, 0, 100), null, 'nothing stored: the page default applies');
    storeNumber(LISTEN_VOLUME_KEY, 35);
    assert.equal(storedNumber(LISTEN_VOLUME_KEY, 0, 100), 35);

    storeNumber(MIC_GAIN_KEY, 55);
    assert.equal(storedNumber(MIC_GAIN_KEY, 0, 40), 40);
    storeNumber(MIC_GAIN_KEY, Number.NaN);
    assert.equal(storedNumber(MIC_GAIN_KEY, 0, 40), 40, 'a non-number is never written');
  });
});

test('unreadable or corrupt storage leaves the defaults in place', () => {
  const corrupt = memoryStorage();
  corrupt.setItem(LISTEN_VOLUME_KEY, 'loud');
  corrupt.setItem(MIC_GAIN_KEY, '');
  withStorage(corrupt, () => {
    assert.equal(storedNumber(LISTEN_VOLUME_KEY, 0, 100), null);
    assert.equal(storedNumber(MIC_GAIN_KEY, 0, 40), null, 'empty is absent, not 0 dB');
  });

  const blocked = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  withStorage(blocked, () => {
    assert.equal(storedNumber(LISTEN_VOLUME_KEY, 0, 100), null);
    assert.doesNotThrow(() => storeNumber(LISTEN_VOLUME_KEY, 50));
  });
});

test('the Mic page names its stored gain at registration and stores what it sends', () => {
  const app = readFileSync('public/app.js', 'utf8');
  assert.match(app, /const rememberedGainDb = storedNumber\(MIC_GAIN_KEY, 0, 40\);\s*if \(rememberedGainDb !== null\) registration\.micGainDb = rememberedGainDb;/);
  assert.match(app, /storeNumber\(MIC_GAIN_KEY, micGainDb\(\)\);\s*updateMixLabels\(\);\s*return true;/);

  const listen = readFileSync('public/listen.js', 'utf8');
  assert.match(listen, /storedNumber\(LISTEN_VOLUME_KEY, 0, 100\)/);
  assert.match(listen, /storeNumber\(LISTEN_VOLUME_KEY, volumePercent\(\)\)/);
});
