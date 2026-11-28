import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  projectFollowerRoom, decideFollowerAction,
  FOLLOWER_ROOM_MAX_AGE_MS, FOLLOWER_ROOM_COAST_MS,
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
  assert.equal(projectFollowerRoom(base, 1000, 1500)?.durationSeconds, 220);
  assert.equal(projectFollowerRoom({ ...base, state: 2 }, 1000, 1500)?.positionSeconds, 80);
  assert.equal(projectFollowerRoom(base, 1000, 1500)?.fresh, true);
  assert.equal(projectFollowerRoom(base, 1000, 1000 + FOLLOWER_ROOM_MAX_AGE_MS + 1)?.fresh, false);
  assert.equal(projectFollowerRoom(base, 1000, 1000 + FOLLOWER_ROOM_COAST_MS + 1), null);
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
  // A newly cued B player is half a second behind while waiting to start.
  // Seek cooldown must never prevent it from actually playing.
  assert.equal(decideFollowerAction(room, {
    ...local, positionSeconds: 79.5, playerState: 5,
  }, 6000, 5000).type, 'play');
  assert.equal(decideFollowerAction(room, {
    ...local, positionSeconds: 70, playerState: 2,
  }, 6000, 5000).type, 'play');
  assert.equal(decideFollowerAction({ ...room, playing: false }, {
    ...local, positionSeconds: 79.5, playerState: 5,
  }, 6000, 5000).type, 'none');
  assert.equal(decideFollowerAction(room, { ...local, positionSeconds: 80.1 }, 6000, 5000).type, 'none');
  assert.equal(decideFollowerAction(room, { ...local, playerState: 3 }, 6000, -Infinity).type, 'none');
  assert.equal(decideFollowerAction(room, { ...local, playbackRate: 1.5 }, 6000, -Infinity).type, 'rate');
  assert.equal(decideFollowerAction(null, local, 6000, -Infinity).type, 'none');
});

test('a lead puts B\'s song ahead of the room, and a new lead moves it however small', () => {
  assert.equal(projectFollowerRoom(base, 1000, 1500, 1_600)?.positionSeconds, 82.1);
  assert.equal(projectFollowerRoom({ ...base, playbackRate: 2 }, 1000, 1000, 500)?.positionSeconds, 81);
  const room = projectFollowerRoom(base, 1000, 1000, 200)!;
  // B is 100 ms behind the room; the lead moves from none to 200 ms, which
  // leaves B 300 ms off: inside the seek threshold, so only the lead moves it.
  const behind = { ...local, positionSeconds: 79.9 };
  assert.equal(decideFollowerAction(room, behind, 9000, -Infinity).type, 'none');
  const moved = decideFollowerAction(room, { ...behind, leadShiftSeconds: .2 }, 9000, -Infinity);
  assert.equal(moved.type, 'seek');
  // By the change from where B is, so the server's lag moves by exactly 200 ms.
  assert.ok(moved.type === 'seek' && Math.abs(moved.positionSeconds - 80.1) < 1e-9, JSON.stringify(moved));
  assert.ok(Math.abs((moved.driftMs ?? 0) + 300) < 1e-6);
  assert.equal(decideFollowerAction(room, { ...behind, leadShiftSeconds: .2 }, 9000, 8000).type, 'none',
    'the seek cooldown still holds');
  // Out of step as well: back to the room, at the new lead.
  const far = decideFollowerAction(room, { ...local, positionSeconds: 79, leadShiftSeconds: .2 }, 9000, -Infinity);
  assert.equal(far.type === 'seek' && far.positionSeconds, 80.2);
  const end = projectFollowerRoom({ ...base, serverTime: 219.9 }, 1000, 1000)!;
  const past = decideFollowerAction(end, { ...local, positionSeconds: 219.9, leadShiftSeconds: 1 }, 9000, -Infinity);
  assert.equal(past.type === 'seek' && past.positionSeconds, 220, 'never past the end');
});

test('B\'s song, ahead of the room, ends first and is not started over', () => {
  // Room 1.2 s from the end; B at a 1.6 s lead has already ended.
  const room = projectFollowerRoom({ ...base, serverTime: 218.8 }, 1000, 1000, 1_600)!;
  assert.equal(room.positionSeconds, 220);
  assert.deepEqual(decideFollowerAction(room, { ...local, positionSeconds: 220, playerState: 0 }, 9000, -Infinity),
    { type: 'none', driftMs: 0 });
  // Ended well before the room's end, B is played again as before.
  const early = projectFollowerRoom({ ...base, serverTime: 200 }, 1000, 1000)!;
  assert.equal(decideFollowerAction(early, { ...local, positionSeconds: 200, playerState: 0 }, 9000, -Infinity).type,
    'play');
});

test('a coasting room keeps B\'s song as it is: no cue, seek, pause or play', () => {
  const room = projectFollowerRoom(base, 1000, 1000 + FOLLOWER_ROOM_MAX_AGE_MS + 500)!;
  assert.equal(room.fresh, false);
  for (const player of [
    { ...local, videoId: null },
    { ...local, positionSeconds: 70 },
    { ...local, playerState: 2 },
  ]) assert.deepEqual(decideFollowerAction(room, player, 9000, -Infinity), { type: 'none', driftMs: null });
  assert.equal(decideFollowerAction({ ...room, playing: false }, local, 9000, -Infinity).type, 'none');
});

test('B playback remains separate from production room song commands and monitor', async () => {
  const ui = await readFile(new URL('../public/choir-follower.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
  const listen = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');
  assert.match(html, /id="choir-follower-player" hidden/);
  assert.match(html, /id="choir-follower-position" hidden/);
  assert.doesNotMatch(html, /choir-follower-panel|choir-follower-start|啟用伴奏/);
  assert.match(ui, /if \(!player && !starting && currentRoom\(\)\?\.fresh\) void startPlayer\(\)/);
  assert.match(ui, /relay-choir-guest-state/);
  assert.doesNotMatch(ui, /startButton|userEnabled|relay:room-song-command-intent/);
  assert.match(ui, /role !== 'observer'/);
  assert.match(bridge, /roomReceivedAtMs: latestRoomReceivedAtMs/);
  assert.match(ui, /relay-choir-local-playback/);
  assert.match(listen, /roomPlaybackRoleForcedMute = shouldForceMuteListen/);
  assert.match(listen, /const forced = forcedByRoomRole \|\| choirLocalPlaybackActive;/);
  assert.match(listen, /relay-choir-local-playback/);
  assert.match(listen, /window\.dispatchEvent\(new Event\('relay-request-choir-local-playback'\)\)/);
  assert.match(listen, /if \(userMuted\)/);
  assert.doesNotMatch(ui, /relay:room-song-command-intent|relay:youtube-telemetry|room-song-command|micCalibration|sendAudioPacket/);
});
