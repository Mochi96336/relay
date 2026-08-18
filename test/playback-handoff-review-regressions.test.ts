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

function topLevelFunctionSection(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is missing`);
  const nextFunction = source.indexOf('\nfunction ', start + declaration.length);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

test('CUED and ENDED cannot become final playback handoff proof', () => {
  const songs = new SongSession();
  songs.update(telemetry(10, { state: 5 }), A, A.participantId, 0);

  const plan = songs.beginHandoff(B, B.participantId, 100);
  assert.ok(plan);
  assert.equal(plan.state, 2,
    'dormant room states are transferred as an explicitly renderable PAUSED target');
  assert.ok(songs.markHandoffReady(B, plan.handoffId, B.participantId, 150));

  const cued = songs.update(telemetry(10, { state: 5 }), B, B.participantId, 180);
  assert.equal(cued.accepted, false);
  assert.equal(cued.reason, 'handoff-song-mismatch');
  assert.equal((songs.statusPayload(180) as Record<string, any>).playbackLeaderParticipantId, A.participantId);

  const ended = songs.update(telemetry(10, { state: 0 }), B, B.participantId, 190);
  assert.equal(ended.accepted, false);
  assert.equal(ended.reason, 'handoff-song-mismatch');

  const paused = songs.update(telemetry(10, { state: 2 }), B, B.participantId, 200);
  assert.equal(paused.accepted, true);
  assert.equal(paused.handoffCompleted, true);
  assert.equal((songs.statusPayload(200) as Record<string, any>).playbackLeaderParticipantId, B.participantId);
});

test('speculative prewarm has an explicit bounded lifetime and formal handoff consumes the timer', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const startSection = topLevelFunctionSection(source, 'async function startPlaybackPrewarm()');
  const cancelSection = topLevelFunctionSection(source, 'function cancelPlaybackPrewarm()');
  const prepareSection = topLevelFunctionSection(source, 'async function prepareRoomSong');

  assert.match(source, /const SPECULATIVE_PREWARM_TIMEOUT_MS = 15_000/);
  assert.match(source, /function armSpeculativePrewarmTimeout\(prewarm\)/);
  assert.match(startSection, /armSpeculativePrewarmTimeout\(speculativePrewarm\)/,
    'a duplicate Mic tap refreshes the same bounded prewarm instead of creating an immortal one');
  assert.match(startSection, /armSpeculativePrewarmTimeout\(prewarm\)/);
  assert.match(cancelSection, /clearSpeculativePrewarmTimer\(\)/);
  assert.match(prepareSection, /clearSpeculativePrewarmTimer\(\)/,
    'formal handoff consumption must retire the speculative expiry callback');
});

test('post-handoff autoplay recovery CTA persists until actual PLAYING is observed', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const renderSection = topLevelFunctionSection(source, 'function renderSnapshot');
  const sampleSection = topLevelFunctionSection(source, 'function sampleNow()');
  const stateSection = topLevelFunctionSection(source, 'function handleStateChange');
  const completeSection = topLevelFunctionSection(source, 'function completeRoomSong');
  const localeSection = topLevelFunctionSection(source, 'function rerenderLocale');

  assert.match(source, /let autoplayRecoveryRequired = false/);
  assert.match(source, /const AUTOPLAY_RECOVERY_NOTE =/);
  assert.match(renderSection, /if \(!autoplayRecoveryRequired\)/,
    'normal 250 ms telemetry must not overwrite the recovery CTA');
  assert.match(completeSection, /autoplayRecoveryRequired = true/);
  assert.match(completeSection, /noteNode\.textContent = AUTOPLAY_RECOVERY_NOTE/);
  assert.match(sampleSection, /snapshot\.state === 1 && autoplayRecoveryRequired/);
  assert.match(stateSection, /event\.data === 1 && autoplayRecoveryRequired/);
  assert.match(localeSection, /autoplayRecoveryRequired/,
    'locale rerender must preserve recovery state instead of replacing it with healthy timeline copy');
});

test('outgoing leader waits for direct release instead of generic observer pause', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const releaseSection = topLevelFunctionSection(source, 'function releaseRoomSong');
  const viewStart = source.indexOf("window.addEventListener('relay:playback-view'");
  assert.ok(viewStart >= 0);
  const viewEnd = source.indexOf("window.addEventListener('relay:playback-prewarm-intent'", viewStart);
  const viewSection = source.slice(viewStart, viewEnd);

  assert.match(source, /const OUTGOING_RELEASE_FALLBACK_MS = 2_000/,
    'a missing direct release is still bounded damage rather than immortal old audio');
  assert.match(viewSection, /activeOutgoingHandoffId/);
  assert.match(viewSection, /outgoingHandoffId = activeOutgoingHandoffId/);

  const observerIndex = viewSection.indexOf("if (nextRole === 'observer')");
  const releaseBarrierIndex = viewSection.indexOf('if (outgoingHandoffId)', observerIndex);
  const genericPauseIndex = viewSection.indexOf("source: 'observer-quiet'", observerIndex);
  assert.ok(observerIndex >= 0 && releaseBarrierIndex > observerIndex);
  assert.ok(genericPauseIndex > releaseBarrierIndex,
    'promotion status must hit the outgoing release barrier before generic observer pause');

  assert.match(releaseSection, /retireOutgoingReleaseBarrier\(\)/);
  assert.match(releaseSection, /player\.pauseVideo\(\)/,
    'the direct release packet remains the normal audible cutover barrier for the old leader');
});
