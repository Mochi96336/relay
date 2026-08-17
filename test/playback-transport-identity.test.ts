import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PLAYBACK_GENERATION_KEY,
  PLAYBACK_TRANSPORT_KEY,
  browserNavigationType,
  preparePlaybackTransportStorage,
  shouldReusePlaybackTransport,
} from '../public/playback-transport-identity.js';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  constructor(entries: Array<[string, string]> = []) {
    for (const [key, value] of entries) this.values.set(key, value);
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const TRANSPORT = 'playback-0123456789abcdef0123456789abcdef';

test('only an explicit reload may inherit an existing logical playback transport', () => {
  assert.equal(shouldReusePlaybackTransport(TRANSPORT, 'reload'), true);
  for (const navigationType of ['navigate', 'back_forward', 'prerender', 'unknown', null]) {
    assert.equal(shouldReusePlaybackTransport(TRANSPORT, navigationType), false, String(navigationType));
  }
  assert.equal(shouldReusePlaybackTransport('bad', 'reload'), false);
});

test('reload preserves transport and generation so the new page can continue the old incarnation', () => {
  const storage = new MemoryStorage([
    [PLAYBACK_TRANSPORT_KEY, TRANSPORT],
    [PLAYBACK_GENERATION_KEY, '1234'],
  ]);

  assert.equal(preparePlaybackTransportStorage(storage, 'reload'), 'reload');
  assert.equal(storage.getItem(PLAYBACK_TRANSPORT_KEY), TRANSPORT);
  assert.equal(storage.getItem(PLAYBACK_GENERATION_KEY), '1234');
});

test('a copied sessionStorage on a non-reload navigation is retired before youtube-sync reads it', () => {
  for (const navigationType of ['navigate', 'back_forward', 'unknown']) {
    const storage = new MemoryStorage([
      [PLAYBACK_TRANSPORT_KEY, TRANSPORT],
      [PLAYBACK_GENERATION_KEY, '1234'],
    ]);

    assert.equal(preparePlaybackTransportStorage(storage, navigationType), 'rotated');
    assert.equal(storage.getItem(PLAYBACK_TRANSPORT_KEY), null);
    assert.equal(storage.getItem(PLAYBACK_GENERATION_KEY), null);
  }
});

test('orphaned generation or invalid transport is reset instead of being inherited', () => {
  const orphaned = new MemoryStorage([[PLAYBACK_GENERATION_KEY, '999']]);
  assert.equal(preparePlaybackTransportStorage(orphaned, 'reload'), 'reset');
  assert.equal(orphaned.getItem(PLAYBACK_GENERATION_KEY), null);

  const invalid = new MemoryStorage([
    [PLAYBACK_TRANSPORT_KEY, 'bad'],
    [PLAYBACK_GENERATION_KEY, '999'],
  ]);
  assert.equal(preparePlaybackTransportStorage(invalid, 'reload'), 'reset');
  assert.equal(invalid.getItem(PLAYBACK_TRANSPORT_KEY), null);
  assert.equal(invalid.getItem(PLAYBACK_GENERATION_KEY), null);
});

test('browser navigation type uses Navigation Timing and fails closed when unavailable', () => {
  assert.equal(browserNavigationType({
    getEntriesByType(type: string) {
      assert.equal(type, 'navigation');
      return [{ type: 'reload' }];
    },
  }), 'reload');
  assert.equal(browserNavigationType({ getEntriesByType: () => [] }), 'unknown');
  assert.equal(browserNavigationType(null), 'unknown');
});

test('playback bootstrap executes before youtube-sync reads session storage', async () => {
  const roleSource = await readFile(new URL('../public/song-role.js', import.meta.url), 'utf8');
  const syncSource = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(roleSource, /^import '\.\/playback-transport-identity\.js';/);
  assert.match(syncSource, /import \{ resolvePlaybackRole \} from '\.\/song-role\.js';/);
  assert.match(syncSource, /relay\.playbackTransportId\.v1/);
  assert.match(syncSource, /relay\.playbackGeneration\.v1/);
});
