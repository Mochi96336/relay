import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MicGainMemory } from '../src/mic-gain-memory.js';

describe('Mic gain memory', () => {
  test('a participant never seen gets the default, and a chosen gain comes back', () => {
    const memory = new MicGainMemory({ defaultGainDb: 24 });
    assert.deepEqual(memory.gainFor('participant-alice'), { gainDb: 24, remembered: false });

    memory.remember('participant-alice', 10);
    memory.remember('participant-bobby', 33);
    assert.deepEqual(memory.gainFor('participant-alice'), { gainDb: 10, remembered: true });
    assert.deepEqual(memory.gainFor('participant-bobby'), { gainDb: 33, remembered: true });

    memory.remember('participant-alice', 0);
    assert.deepEqual(memory.gainFor('participant-alice'), { gainDb: 0, remembered: true });
  });

  test('ignores a non-finite gain instead of storing it', () => {
    const memory = new MicGainMemory({ defaultGainDb: 24 });
    memory.remember('participant-alice', 12);
    memory.remember('participant-alice', Number.NaN);
    assert.deepEqual(memory.gainFor('participant-alice'), { gainDb: 12, remembered: true });
  });

  test('forgets the participant who set a gain longest ago once full', () => {
    const memory = new MicGainMemory({ defaultGainDb: 24, maxParticipants: 2 });
    memory.remember('participant-alice', 10);
    memory.remember('participant-bobby', 20);
    memory.remember('participant-alice', 11);
    memory.remember('participant-carol', 30);

    assert.equal(memory.gainFor('participant-bobby').remembered, false);
    assert.equal(memory.gainFor('participant-alice').gainDb, 11);
    assert.equal(memory.gainFor('participant-carol').gainDb, 30);
  });

  test('rejects nonsensical configuration', () => {
    assert.throws(() => new MicGainMemory({ defaultGainDb: Number.NaN }), RangeError);
    assert.throws(() => new MicGainMemory({ defaultGainDb: 24, maxParticipants: 0 }), RangeError);
  });
});
