import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PlaybackHandoff, HANDOFF_STALL_REPORT_MS, type HandoffPlayer } from '../public/playback-handoff.js';
import { SongSession } from '../src/song-session.js';
import { FakeClock } from './support/fake-clock.js';
import { telemetry } from './support/song-handoff-telemetry.js';

/**
 * The server's handoff plan driven through the client's PlaybackHandoff,
 * against a player that behaves like YouTube near the end of a video.
 *
 * Each half used to be tested alone: the client against plans the server
 * never sends (state 0), the server against fake targets that could play
 * anywhere. An ended song therefore could not be handed to a new singer from
 * 2026-08 until #642.
 */

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 1 };
const DURATION = 211;

// Measured 2026-10-22 with headless Chromium and an embeddable video, muted
// loadVideoById then pauseVideo on the first PLAYING:
// - loaded within 1 s of the end, it stays UNSTARTED with nothing buffered;
// - paused within about 3.5 s of the end, it shows PAUSED, then slides into ENDED.
const LOAD_STALLS_WITHIN_S = 1;
const PAUSE_SLIDES_WITHIN_S = 3.5;
const LOAD_MS = 300;

/** A muted YouTube player as far as a handoff can see it. */
function youtubeLikePlayer(clock: FakeClock, onState: (state: number) => void) {
  let state = 5;
  let videoId: string | null = null;
  let position = 0;
  let playingSince: number | null = null;
  let buffered = 0;
  let muted = false;
  const currentTime = () => playingSince === null ? position : position + (clock.now - playingSince) / 1000;
  const set = (next: number) => {
    if (next === 1) playingSince ??= clock.now;
    else if (playingSince !== null) { position = currentTime(); playingSince = null; }
    state = next;
    onState(next);
  };
  const player: HandoffPlayer & { buffered(): number } = {
    getVideoData: () => ({ video_id: videoId }),
    getPlayerState: () => state,
    getCurrentTime: () => currentTime(),
    getVideoLoadedFraction: () => buffered,
    isMuted: () => muted,
    mute() { muted = true; },
    unMute() { muted = false; },
    setPlaybackRate() {},
    loadVideoById(input) {
      videoId = input.videoId; position = input.startSeconds; playingSince = null; buffered = 0;
      set(-1);
      if (input.startSeconds > DURATION - LOAD_STALLS_WITHIN_S) return;
      clock.setTimeout(() => set(3), 50);
      clock.setTimeout(() => { buffered = 0.5; set(1); }, LOAD_MS);
    },
    seekTo(seconds) { position = seconds; if (playingSince !== null) playingSince = clock.now; },
    playVideo() { set(1); },
    pauseVideo() {
      set(2);
      if (currentTime() > DURATION - PAUSE_SLIDES_WITHIN_S) clock.setTimeout(() => set(0), 200);
    },
    buffered: () => buffered,
  };
  return player;
}

/** One handoff from A's ended, paused or playing room to B, both halves real. */
async function handOver(room: { state: number; currentTime: number }) {
  const clock = new FakeClock();
  const songs = new SongSession();
  songs.update(telemetry(room.currentTime, { state: room.state, duration: DURATION }), A, null, 0);

  const ready: string[] = [];
  const stalled: unknown[][] = [];
  let handoff: PlaybackHandoff | null = null;
  const player = youtubeLikePlayer(clock, (state) => handoff?.observeState(state));
  handoff = new PlaybackHandoff({
    getPlayer: () => player,
    ensurePlayer: async () => player,
    onMutation() {}, onTimelineBoundary() {}, onNote() {}, onFailure() {}, sampleNow() {},
    onReady: (id) => ready.push(id),
    onStalled: (...report) => stalled.push(report),
    now: () => clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout,
  });

  // youtube.js prepareRoomSong / commitRoomSong pass the plan fields through like this.
  const plan = songs.beginHandoff(B, B.participantId, 0)!;
  await handoff.prepare({
    handoffId: plan.handoffId, videoId: plan.videoId, targetTime: plan.serverTime,
    desiredState: plan.state, playbackRate: plan.playbackRate,
  });
  clock.advance(1_000);
  if (ready.length === 0) {
    clock.advance(HANDOFF_STALL_REPORT_MS);
    return { completed: false, plan, stalled };
  }

  const commit = songs.markHandoffReady(B, plan.handoffId, B.participantId, clock.now)!;
  handoff.commit({ handoffId: commit.handoffId, serverTime: commit.serverTime, state: commit.state });
  clock.advance(400);
  const proof = songs.update(telemetry(player.getCurrentTime() as number, {
    state: player.getPlayerState(), duration: DURATION, bufferedFraction: player.buffered(),
  }), B, B.participantId, clock.now);
  return {
    completed: proof.handoffCompleted === true,
    plan,
    stalled,
    leader: (songs.statusPayload(clock.now) as Record<string, unknown>).playbackLeaderParticipantId,
    targetState: player.getPlayerState(),
  };
}

describe('song handoff, server plan through the client player', () => {
  test('an ended song reaches the new singer, paused clear of its end', async () => {
    const result = await handOver({ state: 0, currentTime: DURATION });
    assert.equal(result.completed, true, JSON.stringify(result.stalled));
    assert.equal(result.leader, B.participantId);
    assert.equal(result.targetState, 2);
  });

  test('a song paused near its end and mid-song both hand over', async () => {
    for (const currentTime of [DURATION - 1, DURATION - 4, 100]) {
      const result = await handOver({ state: 2, currentTime });
      assert.equal(result.completed, true, `paused at ${currentTime}: ${JSON.stringify(result.stalled)}`);
      assert.equal(result.targetState, 2);
    }
  });

  test('a playing song hands over playing', async () => {
    const result = await handOver({ state: 1, currentTime: 100 });
    assert.equal(result.completed, true, JSON.stringify(result.stalled));
    assert.equal(result.targetState, 1);
  });

  test('the player model reproduces the 2026-10-22 stall when a plan sits on the end', async () => {
    // Without this, the cases above could pass against a player that plays anywhere.
    const clock = new FakeClock();
    const stalled: unknown[][] = [];
    let handoff: PlaybackHandoff | null = null;
    const player = youtubeLikePlayer(clock, (state) => handoff?.observeState(state));
    handoff = new PlaybackHandoff({
      getPlayer: () => player, ensurePlayer: async () => player,
      onMutation() {}, onTimelineBoundary() {}, onNote() {}, onFailure() {}, sampleNow() {}, onReady() {},
      onStalled: (...report) => stalled.push(report),
      now: () => clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout,
    });
    await handoff.prepare({ handoffId: 'h1', videoId: 'dQw4w9WgXcQ', targetTime: DURATION, desiredState: 2, playbackRate: 1 });
    clock.advance(HANDOFF_STALL_REPORT_MS);
    assert.deepEqual(stalled, [['h1', { blocker: 'state--1', playerState: -1, buffered: 0, muted: true }]]);
  });
});
