import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choirCommandMessage } from '../public/choir-commands.js';

test('each second Mic command carries only its own fields', () => {
  const extra = { capability: 'secret', participantId: 'someone-else', seat: 'primary' };
  assert.deepEqual(choirCommandMessage({ type: 'choir-secondary-join', ...extra }),
    { type: 'choir-secondary-join' });
  assert.deepEqual(choirCommandMessage({ type: 'choir-secondary-join', resume: true, expectedPrimaryId: 'a', ...extra }),
    { type: 'choir-secondary-join', resume: true, expectedPrimaryId: 'a' });
  assert.deepEqual(choirCommandMessage({ type: 'choir-secondary-gain', micGainDb: 12, ...extra }),
    { type: 'choir-secondary-gain', micGainDb: 12 });
  assert.deepEqual(choirCommandMessage({ type: 'choir-secondary-media-claim-request', ...extra }),
    { type: 'choir-secondary-media-claim-request' });
  assert.deepEqual(choirCommandMessage({ type: 'choir-probe-request', ...extra }), { type: 'choir-probe-request' });
  assert.deepEqual(choirCommandMessage({
    type: 'choir-probe-played', requestId: 7, generation: 3, timingDiagnostics: { a: 1 }, ...extra,
  }), { type: 'choir-probe-played', requestId: 7, generation: 3, timingDiagnostics: { a: 1 } });
  assert.deepEqual(choirCommandMessage({
    type: 'choir-secondary-song-anchor', videoId: 'v', state: 1, currentTime: 2, playbackRate: 1,
    captureAnchor: { sampleIndex: 9 }, ...extra,
  }), {
    type: 'choir-secondary-song-anchor', videoId: 'v', state: 1, currentTime: 2, playbackRate: 1,
    captureAnchor: { sampleIndex: 9 },
  });
});

test('reasons are bounded, and anything else is not a command', () => {
  assert.deepEqual(choirCommandMessage({ type: 'choir-secondary-withdraw', reason: 'x'.repeat(200) }),
    { type: 'choir-secondary-withdraw', reason: 'x'.repeat(80) });
  assert.deepEqual(choirCommandMessage({ type: 'choir-secondary-withdraw', reason: 5 }),
    { type: 'choir-secondary-withdraw', reason: 'unspecified' });
  assert.equal((choirCommandMessage({ type: 'choir-probe-failed', reason: 'y'.repeat(500) })?.reason as string).length, 200);
  for (const payload of [null, undefined, {}, { type: 'register' }, { type: 'toString' },
    { type: 'choir-secondary-invite' }, { type: 'choir-room-begin' }]) {
    assert.equal(choirCommandMessage(payload), null, JSON.stringify(payload));
  }
});
