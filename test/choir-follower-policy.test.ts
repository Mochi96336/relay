import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ChoirFollowerPolicy, type ChoirFollowerRoom, type ChoirFollowerLocal } from '../src/choir-follower-policy.js';
import { projectChoirMicActions } from '../src/choir-mic-actions.js';

const room: ChoirFollowerRoom = {
  videoId: 'abcdefghijk', songEpoch: 1, positionSeconds: 80,
  playbackRate: 1, state: 'playing',
};
const local: ChoirFollowerLocal = {
  videoId: 'abcdefghijk', positionSeconds: 80.12, playbackRate: 1,
  state: 'playing', userGestureReady: true,
};

describe('Choir follower only controls its own player', () => {
  test('keeps small device drift rather than seeking every observation', () => {
    const policy = new ChoirFollowerPolicy();
    const decision = policy.decide({ room, local, nowMs: 5_000, roomFresh: true });
    assert.equal(decision.action, 'none');
    if (decision.action !== 'none') return;
    assert.equal(decision.reason, 'within-tolerance');
    assert.ok(Math.abs(decision.signedDriftMs! - 120) < 0.001);
  });

  test('large drift seeks at a bounded interval, rather than hunting continuously', () => {
    const policy = new ChoirFollowerPolicy();
    const behind = { ...local, positionSeconds: 79 };
    assert.equal(policy.decide({ room, local: behind, nowMs: 1_000, roomFresh: true }).action, 'seek');
    const blocked = policy.decide({ room, local: behind, nowMs: 2_000, roomFresh: true });
    assert.deepEqual(blocked, { action: 'none', reason: 'seek-cooldown', signedDriftMs: -1000 });
    assert.equal(policy.decide({ room, local: behind, nowMs: 4_000, roomFresh: true }).action, 'seek');
  });

  test('song epochs and video changes reload only the local follower', () => {
    const policy = new ChoirFollowerPolicy();
    const load = policy.decide({ room: { ...room, songEpoch: 2 },
      local: { ...local, videoId: null }, nowMs: 9_000, roomFresh: true });
    assert.deepEqual(load, {
      action: 'load', videoId: room.videoId, positionSeconds: room.positionSeconds, songEpoch: 2,
    });
    const newSong = policy.decide({ room: { ...room, songEpoch: 3, videoId: '01234567890' },
      local, nowMs: 9_100, roomFresh: true });
    assert.equal(newSong.action, 'load');
  });

  test('does not project an untrusted or stale room clock', () => {
    const policy = new ChoirFollowerPolicy();
    const result = policy.decide({ room, local, nowMs: 5_000, roomFresh: false });
    assert.deepEqual(result, {
      action: 'none', reason: 'room-not-authoritative', signedDriftMs: null,
    });
  });

  test('buffering must not trigger relentless seeks; user gesture is respected', () => {
    const policy = new ChoirFollowerPolicy();
    assert.deepEqual(policy.decide({ room, local: { ...local, userGestureReady: false },
      nowMs: 1000, roomFresh: true }), { action: 'play', requiresUserGesture: true });
    assert.equal(policy.decide({ room, local: { ...local, state: 'buffering', positionSeconds: 70 },
      nowMs: 1000, roomFresh: true }).action, 'none');
  });

  test('a Seek by A while paused repositions the local follower before Play', () => {
    const policy = new ChoirFollowerPolicy();
    const seek = policy.decide({
      room: { ...room, state: 'paused', positionSeconds: 110 },
      local: { ...local, state: 'paused' }, nowMs: 1000, roomFresh: true,
    });
    assert.equal(seek.action, 'seek');
    if (seek.action !== 'seek') return;
    assert.equal(seek.positionSeconds, 110);
    assert.ok(Math.abs(seek.signedDriftMs + 29_880) < 0.001);
    const repeated = policy.decide({
      room: { ...room, state: 'paused', positionSeconds: 110 },
      local: { ...local, state: 'paused' }, nowMs: 1200, roomFresh: true,
    });
    assert.equal(repeated.action, 'none');
  });

  test('a paused follower seeks to room time before starting on resume', () => {
    const policy = new ChoirFollowerPolicy();
    const out = policy.decide({
      room, local: { ...local, state: 'paused', positionSeconds: 55 },
      nowMs: 10_000, roomFresh: true,
    });
    assert.equal(out.action, 'seek');
    if (out.action !== 'seek') return;
    assert.equal(out.positionSeconds, 80);
    const cooldown = policy.decide({
      room, local: { ...local, state: 'paused', positionSeconds: 55 },
      nowMs: 11_000, roomFresh: true,
    });
    assert.equal(cooldown.action, 'none');
    assert.equal(policy.decide({
      room, local: { ...local, state: 'paused', positionSeconds: 80.1 },
      nowMs: 11_000, roomFresh: true,
    }).action, 'play');
  });

  test('A can pause the room; the follower pauses only its own YouTube', () => {
    const policy = new ChoirFollowerPolicy();
    assert.deepEqual(policy.decide({ room: { ...room, state: 'paused' },
      local, nowMs: 1000, roomFresh: true }), { action: 'pause' });
  });
});

describe('small secondary Mic action remains gated off until backend exists', () => {
  const base = {
    featureReady: true, participantId: 'singer-b',
    primaryId: 'singer-a', secondaryIds: [] as string[],
    maxSingers: 2, primaryTransportHealthy: true,
  };

  test('only a real ready multi-publisher room may show + Secondary Mic', () => {
    const hidden = projectChoirMicActions({ ...base, featureReady: false });
    assert.equal(hidden.showSecondaryButton, false);
    assert.equal(hidden.primaryAction, 'take-over');
    const visible = projectChoirMicActions(base);
    assert.deepEqual(visible, {
      primaryAction: 'take-over', secondaryAction: 'join-secondary',
      showSecondaryButton: true, secondaryEnabled: true, reason: 'ready',
    });
  });

  test('secondary singer can leave while another primary remains', () => {
    const state = projectChoirMicActions({ ...base, secondaryIds: ['singer-b'] });
    assert.equal(state.secondaryAction, 'leave-secondary');
    assert.equal(state.secondaryEnabled, true);
  });

  test('main singer sees no secondary action; reconnect is explicit', () => {
    const x = projectChoirMicActions({ ...base, participantId: 'singer-a',
      primaryTransportHealthy: false });
    assert.equal(x.primaryAction, 'retry-primary');
    assert.equal(x.showSecondaryButton, false);
  });

  test('without main Mic, B stays secondary but nobody is auto-promoted', () => {
    const x = projectChoirMicActions({
      ...base, primaryId: null, secondaryIds: ['singer-b'],
    });
    assert.equal(x.primaryAction, 'take-mic');
    assert.equal(x.secondaryAction, 'leave-secondary');
    const outsider = projectChoirMicActions({
      ...base, primaryId: null, secondaryIds: ['singer-c'],
    });
    assert.equal(outsider.showSecondaryButton, false);
    assert.equal(outsider.primaryAction, 'take-mic');
  });

  test('full room shows disabled secondary addition but retains takeover', () => {
    const x = projectChoirMicActions({
      ...base, secondaryIds: ['singer-c'],
    });
    assert.equal(x.secondaryEnabled, false);
    assert.equal(x.primaryAction, 'take-over');
  });
});
