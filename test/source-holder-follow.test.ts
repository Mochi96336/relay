import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';
const source = parseTypeScriptSource(new URL('../public/source.js', import.meta.url),
  readFileSync(new URL('../public/source.js', import.meta.url), 'utf8'));

function follower(current: number) {
  const seeks: number[] = [];
  const messages: any[] = [];
  let now = 10000;
  const context = vm.createContext({
    latestTimeline: { connected: true, videoId: 'test', state: 1,
      playbackRate: 1, serverTime: 100, youtubeTime: 0 },
    robotSuperseded: false, playerReady: true, armed: true, ROBOT_MODE: true,
    loadedVideoId: 'test', robotDeltaSuppressedUntil: 0,
    offsetReportedSinceSeek: true, ROBOT_DELTA_SETTLE_MS: 1000,
    performance: { now: () => now }, Date,
    console: { warn: (_message: string, error: unknown) => { throw error; } },
    safePlaybackRate: () => 1, safePlayerTime: () => current,
    safePlayerState: () => 1, renderTimeline: () => {},
    send: (message: any) => messages.push(message),
    player: { getPlayerState: () => 1, getCurrentTime: () => current,
      getPlaybackRate: () => 1, pauseVideo: () => {},
      seekTo: (seconds: number) => seeks.push(seconds) },
  });
  vm.runInContext(functionCode(source, 'applyTimeline'), context);
  return { context, seeks, messages,
    tick: (time = now) => { now = time; vm.runInContext('applyTimeline();', context); } };
}

for (const delta of [0.449, 0.45, 0.451, -0.449, -0.45, -0.451]) {
  test(`Robot 450 ms fence: signed offset ${delta * 1000} ms`, () => {
    const robot = follower(delta);
    robot.tick();
    const exceedsFence = Math.abs(delta) > 0.45;
    assert.equal(robot.seeks.length, exceedsFence ? 1 : 0);
    assert.equal(robot.messages[0].type, exceedsFence ? 'source-seeked' : 'robot-player-offset');
    if (!exceedsFence) assert.equal(robot.messages[0].offsetMs, delta * 1000);
    else assert.equal(robot.seeks[0], 0, 'seek uses the holder target');
  });
}

test('After seek, settle for one second and report an offset before another correction', () => {
  const robot = follower(0.6);
  robot.tick();
  robot.tick(10999);
  assert.equal(robot.messages.length, 1, 'no transient offset during settling');
  robot.tick(11000);
  assert.equal(robot.seeks.length, 1);
  assert.equal(robot.messages[1].type, 'robot-player-offset');
  assert.equal(robot.messages[1].offsetMs, 600);
  robot.tick(11250);
  assert.equal(robot.seeks.length, 2, 'fresh offset must unlock the next correction');
  assert.equal(robot.messages[2].type, 'source-seeked');
});

test('Disconnected or unarmed Robot cannot correct playback', () => {
  for (const disconnected of [true, false]) {
    const robot = follower(10);
    if (disconnected) robot.context.latestTimeline.connected = false;
    else robot.context.armed = false;
    robot.tick();
    assert.equal(robot.seeks.length, 0);
    assert.equal(robot.messages.length, 0);
  }
});

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
