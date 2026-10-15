import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  projectFollowerRoom, decideFollowerAction,
  FOLLOWER_ROOM_MAX_AGE_MS,
} from '../public/choir-follower-clock.js';

const base = {
  connected: true, handoffState: 'idle', videoId: 'abcdefghijk',
  revision: 5, state: 1, serverTime: 80, playbackRate: 1, duration: 220,
};
const local = {
  ready: true, videoId: 'abcdefghijk', positionSeconds: 80,
  playbackRate: 1, playerState: 1,
};

test('room song projects only from an actually fresh server room packet', () => {
  assert.equal(projectFollowerRoom(base, 1000, 1500)?.positionSeconds, 80.5);
  assert.equal(projectFollowerRoom({ ...base, state: 2 }, 1000, 1500)?.positionSeconds, 80);
  assert.equal(projectFollowerRoom(base, 1000, 1000 + FOLLOWER_ROOM_MAX_AGE_MS + 1), null);
  assert.equal(projectFollowerRoom(base, null, 1000), null);
  assert.equal(projectFollowerRoom({ ...base, connected: false }, 1000, 1100), null);
  assert.equal(projectFollowerRoom({ ...base, handoffState: 'committing' }, 1000, 1100), null);
  assert.equal(projectFollowerRoom({ ...base, videoId: 'INVALID' }, 1000, 1100), null);
  assert.equal(projectFollowerRoom({ ...base, state: 3 }, 1000, 1100), null);
  assert.equal(projectFollowerRoom({ ...base, state: 1, serverTime: 219.8 }, 1000, 1500)?.positionSeconds, 220);
});

test('B follows by cue/play/pause/seek, never by Mic read-head changes', () => {
  const room = projectFollowerRoom(base, 1000, 1000)!;
  assert.deepEqual(decideFollowerAction(room, { ...local, videoId: null }, 1000, -Infinity), {
    type: 'cue', videoId: base.videoId, positionSeconds: 80, driftMs: null,
  });
  assert.equal(decideFollowerAction(room, { ...local, playerState: 2 }, 1000, -Infinity).type, 'play');
  assert.equal(decideFollowerAction({ ...room, playing: false }, local, 1000, -Infinity).type, 'pause');
  assert.equal(decideFollowerAction(room, { ...local, positionSeconds: 79.1 }, 5000, -Infinity).type, 'seek');
  assert.equal(decideFollowerAction(room, { ...local, positionSeconds: 79.1 }, 6000, 5000).type, 'none');
  assert.equal(decideFollowerAction(room, { ...local, positionSeconds: 80.1 }, 6000, 5000).type, 'none');
  assert.equal(decideFollowerAction(room, { ...local, playerState: 3 }, 6000, -Infinity).type, 'none');
  assert.equal(decideFollowerAction(room, { ...local, playbackRate: 1.5 }, 6000, -Infinity).type, 'rate');
  assert.equal(decideFollowerAction(null, local, 6000, -Infinity).type, 'none');
});

test('B playback remains separate from production room song commands and monitor', async () => {
  const ui = await readFile(new URL('../public/choir-follower.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
  assert.match(html, /id="choir-follower-player" hidden/);
  assert.match(html, /id="choir-follower-position" hidden/);
  assert.doesNotMatch(html, /choir-follower-panel|choir-follower-start|啟用伴奏/);
  assert.match(ui, /if \(!player && !starting && currentRoom\(\)\) void startPlayer\(\)/);
  assert.match(ui, /relay-choir-guest-state/);
  assert.doesNotMatch(ui, /startButton|userEnabled|relay:room-song-command-intent/);
  assert.match(ui, /role !== 'observer'/);
  assert.match(bridge, /roomReceivedAtMs: latestRoomReceivedAtMs/);
  assert.doesNotMatch(ui, /relay:room-song-command-intent|relay:youtube-telemetry|room-song-command|micCalibration|sendAudioPacket/);
});
