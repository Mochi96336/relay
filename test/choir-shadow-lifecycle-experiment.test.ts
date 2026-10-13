import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SongSession } from '../src/song-session.js';
import { SourceRuntime } from '../src/source-runtime.js';
import { ChoirShadowLifecycleExperiment } from '../src/choir-shadow-lifecycle-experiment.js';

const VIDEO = 'dQw4w9WgXcQ';
const leader = { participantId: 'p-A', transportId: 'page-A', generation: 1 };
type RobotSocket = { open: boolean; isRobotSource?: boolean };
const observation = (values: Record<string, unknown> = {}) => ({
  videoId: VIDEO, state: 1, currentTime: 12, duration: 200,
  playbackRate: 1, bufferedFraction: .7, ...values,
});
function make() {
  const songs = new SongSession();
  const robot = new SourceRuntime<RobotSocket>({ isConnected: s => s.open });
  const socket: RobotSocket = { open: true };
  robot.attachRobot(socket);
  const shadow = new ChoirShadowLifecycleExperiment(songs, robot, {
    sampleRate: 48_000, frameMs: 20, prebufferMs: 400,
    retentionMs: 3_000, outputHoldbackMs: 200, contentHistoryMs: 7_000,
  });
  return { songs, robot, socket, shadow };
}

describe('Choir server-only shadow lifecycle and explicit fresh-room restart', () => {
  test('does not allocate room until authenticated SongSession and Robot backing PCM exist', () => {
    const { songs, robot, shadow } = make();
    assert.equal(shadow.observe(100, 9).state, 'awaiting-authority');
    assert.equal(songs.update(observation(), leader, null, 100).accepted, true);
    assert.equal(shadow.observe(100, null).state, 'awaiting-authority');
    assert.equal(shadow.observe(100, 9).state, 'shadow-active');
    assert.deepEqual(shadow.snapshot(), {
      state: 'shadow-active', roomEpoch: 1, songEpoch: 1,
      backingGeneration: 9, videoId: VIDEO,
    });
    assert.equal(shadow.observe(200, 9).state, 'shadow-active',
      'a normal projection must not cause a room restart');
    assert.equal(robot.generation, 0);
  });

  test('seek or Robot change retires the room; PLAYING again does not automatically rearm it', () => {
    for (const operation of ['seek', 'robot-replace', 'robot-disconnect'] as const) {
      const { songs, robot, socket, shadow } = make();
      assert.equal(songs.update(observation(), leader, null, 0).accepted, true);
      assert.equal(shadow.observe(0, 9).state, 'shadow-active');
      if (operation === 'seek') {
        assert.equal(songs.update(observation({ currentTime: 80 }), leader, null, 100).accepted,
          true);
      } else if (operation === 'robot-replace') {
        robot.attachRobot({ open: true });
      } else {
        robot.detachRobot(socket);
      }
      assert.equal(shadow.observe(120, 9).state, 'restart-required');
      assert.deepEqual(shadow.snapshot(), {
        state: 'restart-required', roomEpoch: null, songEpoch: null,
        backingGeneration: null, videoId: null,
      });
      assert.equal(shadow.observe(250, 9).state, 'restart-required',
        'restored heartbeat never inherits retired calibration authority');
      assert.equal(shadow.authorizeExplicitFreshRoom(0, 2, 2), false);
      assert.equal(shadow.authorizeExplicitFreshRoom(1, 1, 2), false);
      assert.equal(shadow.authorizeExplicitFreshRoom(1, 2, 1), false);
      assert.equal(shadow.authorizeExplicitFreshRoom(1, 2, 2), true);
      assert.equal(shadow.observe(300, 9).state,
        operation === 'seek' ? 'shadow-active' : operation === 'robot-replace'
          ? 'shadow-active' : 'awaiting-authority');
      assert.equal(shadow.snapshot().roomEpoch,
        operation === 'robot-disconnect' ? null : 2);
      assert.equal(shadow.authorizeExplicitFreshRoom(1, 2, 2), false);
    }
  });

  test('backing PCM generation loss revokes shadow without resetting production SongSession', () => {
    const { songs, shadow } = make();
    songs.update(observation(), leader, null, 0);
    assert.equal(shadow.observe(0, 9).state, 'shadow-active');
    assert.equal(shadow.observe(20, 10).state, 'restart-required');
    assert.equal(shadow.observe(40, 10).state, 'restart-required');
    assert.equal((songs.statusPayload(40) as Record<string, unknown>).leaderFresh, true);
    assert.equal(shadow.authorizeExplicitFreshRoom(1, 4, 5), true);
    assert.equal(shadow.observe(60, 10).state, 'shadow-active');
    assert.deepEqual(shadow.snapshot(), {
      state: 'shadow-active', roomEpoch: 4, songEpoch: 5,
      backingGeneration: 10, videoId: VIDEO,
    });
  });

  test('a shadow room never obtains Mic admissions or live media transport by observing', () => {
    const { songs, shadow } = make();
    songs.update(observation(), leader, null, 0);
    const snapshot = shadow.observe(0, 9);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'backingGeneration', 'roomEpoch', 'songEpoch', 'state', 'videoId',
    ]);
    assert.equal('admitTrusted' in shadow, false);
    assert.equal('receiveFromTransport' in shadow, false);
    assert.equal('renderDue' in shadow, false);
  });
});
