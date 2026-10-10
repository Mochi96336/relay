import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';
const source = parseTypeScriptSource(new URL('../public/source.js', import.meta.url),
  readFileSync(new URL('../public/source.js', import.meta.url), 'utf8'));

test('Robot seeks to the holder even when it is close to a drifting server clock', () => {
  const seeks: number[] = [];
  const messages: any[] = [];
  const context = vm.createContext({
    latestTimeline: { connected: true, videoId: 'dQw4w9WgXcQ', state: 1,
      playbackRate: 1, serverTime: 220.86, youtubeTime: 214.59 },
    robotSuperseded: false, playerReady: true, armed: true, ROBOT_MODE: true,
    loadedVideoId: 'dQw4w9WgXcQ', robotDeltaSuppressedUntil: 0,
    offsetReportedSinceSeek: true, ROBOT_DELTA_SETTLE_MS: 1000,
    performance: { now: () => 10000 }, Date, console,
    safePlaybackRate: () => 1, safePlayerTime: () => 220.71,
    safePlayerState: () => 1, renderTimeline: () => {},
    send: (m: any) => messages.push(m),
    player: { getPlayerState: () => 1, seekTo: (s: number) => seeks.push(s) },
  });
  vm.runInContext(functionCode(source, 'applyTimeline') + '\napplyTimeline();', context);
  assert.deepEqual(seeks, [214.59]);
  assert.equal(messages[0].reason, 'follower-correction');
  assert.equal(messages[0].fromMediaTime, 220.71);
  assert.equal(messages[0].toMediaTime, 214.59);
  vm.runInContext('applyTimeline();', context);
  assert.equal(seeks.length, 1, 'settling window must prevent repeated seeks');
});
