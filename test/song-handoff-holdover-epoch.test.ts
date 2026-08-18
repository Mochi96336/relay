import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SongSession } from '../src/song-session.js';

const VIDEO = 'dQw4w9WgXcQ';
const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 1 };

function telemetry(currentTime: number, overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    ...overrides,
  };
}

function committingHandoff() {
  const songs = new SongSession();
  assert.equal(songs.update(telemetry(10), A, A.participantId, 0).accepted, true);
  const plan = songs.beginHandoff(B, B.participantId, 100);
  assert.ok(plan);
  assert.ok(songs.markHandoffReady(B, plan.handoffId, B.participantId, 150));
  return songs;
}

test('handoff timeout after Mic ownership left the target cannot mint stale holdover authority', () => {
  const songs = committingHandoff();

  // Transport expiry may release Mic ownership without cancelling the prepared
  // playback handoff. If that handoff later reaches its watchdog, the failure
  // belongs to no current B ownership epoch and must not create an A-for-B
  // holdover that can revive when B acquires Mic again in the future.
  assert.equal(songs.sweepHandoff(true, 5_151, null), true);
  assert.equal((songs.statusPayload(5_151) as Record<string, unknown>).handoffState, 'idle');

  const staleAuthority = songs.update(telemetry(15.2), A, B.participantId, 5_200);
  assert.equal(staleAuthority.accepted, false);
  assert.equal(staleAuthority.reason, 'mic-owner-required');
});

test('a failed-handoff holdover is retired by the next Mic ownership epoch', () => {
  const songs = committingHandoff();

  // B still owns Mic at failure time, so continuity for A is valid inside this
  // ownership epoch.
  assert.equal(songs.sweepHandoff(true, 5_151, B.participantId), true);
  const sameEpoch = songs.update(telemetry(15.2), A, B.participantId, 5_200);
  assert.equal(sameEpoch.accepted, true);

  assert.equal(songs.retireFailedHandoffHoldover(), true);
  const nextEpoch = songs.update(telemetry(15.3), A, B.participantId, 5_300);
  assert.equal(nextEpoch.accepted, false);
  assert.equal(nextEpoch.reason, 'mic-owner-required');
});

test('server adapter passes current Mic ownership into sweep and retires holdover on every real owner transition', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /youtubeTimeline\.sweepHandoff\([\s\S]*?playbackTransportIsConnected\(target\),[\s\S]*?nowMs,[\s\S]*?participants\.micOwnerId,[\s\S]*?\)/,
    'watchdog failure must decide holdover from current ownership, not only the historical target',
  );
  assert.match(
    source,
    /if \(effects\.changed\) youtubeTimeline\.retireFailedHandoffHoldover\(\)/,
    'every real Mic owner transition must invalidate historical failed-handoff authority',
  );
});
