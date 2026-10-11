import assert from 'node:assert/strict';
import test from 'node:test';
import { describeListeners } from '../public/listener-diagnostics-model.js';
import { diagnosticsTranslator } from '../public/diagnostics-copy.js';

test('receiver rows separate identities and do not call historical counters a current fault', () => {
  const rows = describeListeners({ selfId: 'a', session: { participants: [{ id: 'a', nickname: 'Phone' }] },
    statusz: { audio: { listenerPlayback: [
      { connectionIncarnation: 1, participantId: 'a', codec: 'opus', reportAgeMs: 30,
        health: { playing: true, contextState: 'running', sampleRate: 48000, underruns: 5, queuedMs: 120, targetPrebufferMs: 180 } },
      { connectionIncarnation: 2, participantId: 'b', codec: 'pcm16', reportAgeMs: null, health: null },
    ] } } }, diagnosticsTranslator('zh-Hant'))!;
  assert.match(rows[0].title, /Phone · 本機 · #1/);
  assert.match(rows[0].summary, /播放中 · Opus/);
  assert.equal(rows[0].rows.find(r => r.key === 'underruns')?.value, '5');
  assert.equal(rows[0].rows.find(r => r.key === 'underruns')!.tone, 'neutral');
  assert.match(rows[1].summary, /尚未回報/);
  assert.equal(rows[1].rows.find(r => r.key === 'buffer')?.value, '—');
});

test('stale receiver metrics stay unknown and absent endpoint differs from no listeners', () => {
  assert.equal(describeListeners({}), null);
  assert.deepEqual(describeListeners({statusz:{audio:{listenerPlayback:[]}}}), []);
  const rows = describeListeners({statusz:{audio:{listenerPlayback:[{connectionIncarnation:3,reportAgeMs:3000,
    health:{playing:true,contextState:'running',queuedMs:500}}]}}})!;
  assert.match(rows[0].summary, /expired/);
  assert.equal(rows[0].rows.find(r=>r.key==='buffer')?.value, '—');
});
