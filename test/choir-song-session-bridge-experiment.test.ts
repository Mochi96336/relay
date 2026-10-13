import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SongSession } from '../src/song-session.js';
import { ChoirDeadlineRoomExperiment } from '../src/choir-deadline-room-experiment.js';
import { ChoirSongSessionBridgeExperiment } from '../src/choir-song-session-bridge-experiment.js';

const VIDEO = 'dQw4w9WgXcQ';
const A = { participantId: 'robot-a', transportId: 'robot-playback-a', generation: 1 };
const RELOAD = { ...A, generation: 2 };
const B = { participantId: 'robot-b', transportId: 'robot-playback-b', generation: 1 };
const telemetry = (override: Record<string, unknown> = {}) => ({
  videoId: VIDEO, state: 1, currentTime: 10, duration: 240,
  playbackRate: 1, bufferedFraction: .7, ...override,
});
const makeRoom = () => new ChoirDeadlineRoomExperiment({
  sampleRate: 48_000, frameMs: 20, prebufferMs: 400, retentionMs: 3_000,
  roomEpochMs: 0, outputHoldbackMs: 200, songEpoch: 7,
  backingGeneration: 9, videoId: VIDEO,
});
const bridgeFor = (songs: SongSession, room: ChoirDeadlineRoomExperiment) =>
  new ChoirSongSessionBridgeExperiment(songs, room, {
    videoId: VIDEO, songEpoch: 7, backingGeneration: 9,
  });

describe('Choir offline bridge consumes real authenticated SongSession authority', () => {
  test('rejects missing and spoofed playback while allowing stable server projection', () => {
    const songs = new SongSession();
    const room = makeRoom();
    const bridge = bridgeFor(songs, room);
    assert.equal(bridge.sync(0), 'awaiting-playback');
    assert.equal(songs.update(telemetry({ videoId: 'bad' }), A, null, 0).accepted,
      false, 'malformed video identity cannot seize SongSession');
    assert.equal(bridge.sync(0), 'awaiting-playback');
    assert.equal(songs.update(telemetry(), A, null, 1).accepted, true);
    assert.equal(bridge.sync(1), 'initialized');
    assert.equal(bridge.sync(100), 'stable');
    assert.equal(songs.update(telemetry({ currentTime: 90 }), B, null, 120).accepted,
      false, 'another publisher cannot overwrite the authorised playback clock');
    assert.equal(bridge.sync(120), 'stable');
    const a = room.admitTrusted({
      verifiedParticipantId: 'A', transportId: 'socket-A',
      seat: 'primary', expectedPrimaryId: null, nowMs: 140,
    });
    assert.equal(a.ok, true);
    assert.equal(room.renderDue(220).state, 'ready');
    assert.equal(bridge.sync(230), 'stable');
    assert.notEqual(room.renderDue(240).state, 'resync-required',
      'regular playing clock progression does not restart Choir every frame');
  });

  test('server accepted pause, seek, rate and page reload each force a new room epoch', () => {
    const variants = [
      { kind: 'pause', source: A, payload: telemetry({ state: 2, currentTime: 10 }) },
      { kind: 'seek', source: A, payload: telemetry({ currentTime: 88 }) },
      { kind: 'rate', source: A, payload: telemetry({ currentTime: 10.2, playbackRate: 1.5 }) },
      { kind: 'reload', source: RELOAD, payload: telemetry({ currentTime: 10.2 }) },
      { kind: 'video', source: A, payload: telemetry({ videoId: 'abcdefghijk', currentTime: 10 }) },
    ];
    for (const item of variants) {
      const songs = new SongSession();
      const room = makeRoom();
      const bridge = bridgeFor(songs, room);
      assert.equal(songs.update(telemetry(), A, null, 0).accepted, true);
      assert.equal(bridge.sync(0), 'initialized');
      assert.equal(songs.update(item.payload, item.source, null, 100).accepted,
        true, item.kind);
      assert.equal(bridge.sync(101), 'invalidated', item.kind);
      assert.deepEqual(room.renderDue(220), {
        state: 'resync-required', frames: [], reason: 'playback-mapping-changed',
      }, item.kind);
      assert.equal(bridge.sync(240), 'invalidated', 'old room cannot resume when status recovers');
    }
  });

  test('stale leader or explicit detach revokes Choir Content without any client epoch', () => {
    for (const detach of [true, false]) {
      const songs = new SongSession();
      const room = makeRoom();
      const bridge = bridgeFor(songs, room);
      assert.equal(songs.update(telemetry(), A, null, 0).accepted, true);
      assert.equal(bridge.sync(0), 'initialized');
      if (detach) {
        assert.equal(songs.detach(A), true);
      } else {
        // Keep output deadlines drained while the SongSession authority ages
        // out; test playback staleness, not the unrelated deadline-stall gate.
        for (let at = 220; at <= 2_500; at += 20)
          assert.equal(room.renderDue(at).state, 'ready');
      }
      assert.equal(bridge.sync(detach ? 100 : 2_500), 'invalidated');
      assert.deepEqual(room.renderDue(detach ? 220 : 2_540), {
        state: 'resync-required', frames: [], reason: 'playback-mapping-changed',
      });
    }
  });

  test('SongSession leader generation must never be mistaken for Robot PCM generation', () => {
    const songs = new SongSession();
    const room = makeRoom();
    const bridge = bridgeFor(songs, room);
    assert.equal(songs.update(telemetry(), A, null, 0).accepted, true);
    // Real playback leader generation 1 is intentionally distinct from
    // Robot backing PCM capture generation 9 in this room.
    assert.equal(bridge.sync(0), 'initialized');
    assert.equal(room.receiveTrustedBacking({
      generation: 9, firstSampleIndex: 0,
      pcm: Buffer.from(new Int16Array(960).fill(5_000).buffer),
    }, 48_000, 20), true);
    assert.equal(bridge.sync(40), 'stable');
  });
});
