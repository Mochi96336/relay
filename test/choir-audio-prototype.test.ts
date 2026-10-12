import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ChoirAudioPrototype, type ChoirAudioIdentity } from '../src/choir-audio-prototype.js';
import { choirAnchorFromDecision } from '../src/choir-alignment-bridge.js';
import { ChoirCalibrationExperiment, type ChoirCalibrationIdentity } from '../src/choir-calibration-experiment.js';
import type { SongSampleAnchor } from '../src/sample-song-fallback.js';

const RATE = 48_000;
const FRAME = 960;
const HOLD = 4_800;
const SONG = 12;
const BACKING = 6;
const A: ChoirAudioIdentity = {
  participantId: 'participant-a', songEpoch: SONG,
  captureGeneration: 1, backingGeneration: BACKING, micSampleRate: RATE,
};
const B: ChoirAudioIdentity = { ...A, participantId: 'participant-b', captureGeneration: 2 };

function subject(options: Partial<ConstructorParameters<typeof ChoirAudioPrototype>[0]> = {}) {
  return new ChoirAudioPrototype({
    sampleRate: RATE, frameSamples: FRAME, outputHoldbackMs: 100,
    retentionMs: 4000, maxSingers: 2, backingGain: .65, ...options,
  });
}
function anchor(id: ChoirAudioIdentity, micAt: number, roomAt = 0) {
  return {
    participantId: id.participantId, songEpoch: id.songEpoch,
    captureGeneration: id.captureGeneration, backingGeneration: id.backingGeneration,
    roomSampleRate: RATE, micSampleRate: id.micSampleRate,
    roomSampleAtAnchor: roomAt, micSampleAtAnchor: micAt,
  };
}
function install(room: ChoirAudioPrototype, id: ChoirAudioIdentity, micAt = 0) {
  assert.equal(room.addSinger(id), true);
  assert.equal(room.installAnchor(anchor(id, micAt), 'content'), true);
}
function packet(room: ChoirAudioPrototype, id: ChoirAudioIdentity, at: number, pcm: Int16Array) {
  return room.receiveMic({
    participantId: id.participantId,
    captureGeneration: id.captureGeneration,
    firstSampleIndex: at,
    pcm,
  });
}
function render(room: ChoirAudioPrototype, start: number, backing = new Int16Array(FRAME), now = start + FRAME + HOLD) {
  return room.render({
    roomStartSample: start, nowRoomSample: now, songEpoch: SONG,
    backingGeneration: BACKING, backing,
  });
}
function ready(value: ReturnType<typeof render>) {
  assert.equal(value.state, 'ready');
  if (value.state !== 'ready') throw Error('frame not ready');
  return value;
}

describe('Choir Audio prototype: actual PCM and one room output clock', () => {
  test('two independent Mic buffers with 300 ms phase offset produce the same aligned vocal event', () => {
    const room = subject();
    install(room, A);
    install(room, B, 14_400);
    const aa = new Int16Array(FRAME);
    const bb = new Int16Array(FRAME);
    aa[400] = 20_000;
    bb[400] = 20_000;
    assert.equal(packet(room, A, 0, aa), 'accepted');
    assert.equal(packet(room, B, 14_400, bb), 'accepted');
    const frame = ready(render(room, 0));
    const loudestIndex = frame.pcm.reduce((index, val, i, v) =>
      Math.abs(val) > Math.abs(v[index]) ? i : index, 0);
    assert.equal(loudestIndex, 400);
    assert.ok(frame.pcm[400] > 1_000);
    assert.deepEqual(frame.singers.map(s => s.availableSamples), [FRAME, FRAME]);
    assert.equal(frame.outputClippedSamples, 0);
  });

  test('fixed holdback waits equally for every singer, and releases only once', () => {
    const room = subject();
    install(room, A);
    const wait = render(room, 0, new Int16Array(FRAME), FRAME + HOLD - 1);
    assert.deepEqual(wait, { state: 'waiting', requiredRoomSample: FRAME + HOLD });
    assert.equal(packet(room, A, 0, new Int16Array(FRAME).fill(8000)), 'accepted');
    assert.equal(ready(render(room, 0)).roomStartSample, 0);
    assert.throws(() => render(room, 0), /exactly one frame/);
    assert.equal(ready(render(room, FRAME)).roomStartSample, FRAME);
  });

  test('late B cannot stall, corrupt, or rewind good singer A', () => {
    const room = subject();
    install(room, A);
    install(room, B);
    assert.equal(packet(room, A, 0, new Int16Array(FRAME * 3).fill(15_000)), 'accepted');
    let frame = ready(render(room, 0));
    assert.equal(frame.singers[0].missingSamples, 0);
    assert.equal(frame.singers[1].missingSamples, FRAME);
    assert.equal(packet(room, B, 0, new Int16Array(FRAME).fill(18_000)), 'late');
    assert.equal(packet(room, B, FRAME, new Int16Array(FRAME).fill(18_000)), 'accepted');
    frame = ready(render(room, FRAME));
    assert.equal(frame.singers[0].missingSamples, 0);
    assert.equal(frame.singers[1].availableSamples, FRAME);
    assert.equal(frame.singers[1].latePackets, 1);
    assert.ok(frame.pcm[500] > 0, 'A continues and B re-enters');
    assert.equal(frame.outputClippedSamples, 0);
  });

  test('main Mic removal does not reset the secondary Mic or the shared backing clock', () => {
    const room = subject();
    install(room, A);
    install(room, B);
    packet(room, B, 0, new Int16Array(FRAME * 2).fill(15_000));
    ready(render(room, 0));
    assert.equal(room.removeSinger(A.participantId), true);
    const frame = ready(render(room, FRAME));
    assert.deepEqual(frame.singers.map(s => s.participantId), [B.participantId]);
    assert.equal(frame.singers[0].availableSamples, FRAME);
    assert.ok(frame.pcm[FRAME - 1] > 0);
    assert.equal(room.removeSinger(A.participantId), false);
  });

  test('capture restart and song/backing epoch change reject stale samples and anchors', () => {
    const room = subject();
    install(room, A);
    packet(room, A, 0, new Int16Array(FRAME).fill(10_000));
    assert.equal(room.receiveMic({
      participantId: A.participantId, captureGeneration: 15,
      firstSampleIndex: 0, pcm: new Int16Array(FRAME),
    }), 'invalid');
    const invalidEpoch = room.render({
      roomStartSample: 0, nowRoomSample: FRAME + HOLD, songEpoch: SONG + 1,
      backingGeneration: BACKING, backing: new Int16Array(FRAME),
    });
    assert.equal(ready(invalidEpoch).singers[0].missingSamples, FRAME);
    assert.equal(room.addSinger({ ...A, captureGeneration: 3 }), true);
    assert.equal(packet(room, A, FRAME, new Int16Array(FRAME)), 'invalid');
    assert.equal(room.installAnchor(anchor(A, 0), 'content'), false);
    assert.equal(ready(render(room, FRAME)).singers[0].missingSamples, FRAME);
  });

  test('two max level voices and max level backing never clip output', () => {
    const room = subject();
    install(room, A); install(room, B);
    for (const id of [A, B]) {
      assert.equal(packet(room, id, 0, new Int16Array(FRAME).fill(32_767)), 'accepted');
    }
    const frame = ready(render(room, 0, new Int16Array(FRAME).fill(32_767)));
    assert.equal(frame.outputClippedSamples, 0);
    assert.ok(Math.max(...frame.pcm) < 32_768);
    assert.ok(Math.max(...frame.pcm) > 0);
  });

  test('native 44.1k singer uses fractional positions independently of 48k room', () => {
    const room = subject();
    const id = { ...A, micSampleRate: 44_100 };
    install(room, id);
    const samples = new Int16Array(900);
    for (let i = 0; i < samples.length; i++) samples[i] = i * 25;
    assert.equal(packet(room, id, 0, samples), 'accepted');
    const frame = ready(render(room, 0));
    assert.equal(frame.singers[0].missingSamples, 0);
    assert.ok(frame.pcm[300] > frame.pcm[100]);
    assert.equal(frame.outputClippedSamples, 0);
  });

  test('ring wrap and duplicate packet cannot poison an already accepted region', () => {
    const room = subject({ retentionMs: 150 });
    install(room, A);
    packet(room, A, 0, new Int16Array(FRAME).fill(10_000));
    packet(room, A, 0, new Int16Array(FRAME).fill(-10_000));
    const frame = ready(render(room, 0));
    assert.ok(frame.pcm[500] > 0, 'first authenticated sample arrival owns overlap');
    // A discontinuous huge future packet pushes the old ring window forward.
    packet(room, A, 300_000, new Int16Array(FRAME).fill(9_000));
    assert.equal(packet(room, A, 0, new Int16Array(FRAME).fill(9_000)), 'late');
  });

  test('revoking B anchor only silences B; a stale held calibration cannot be installed', () => {
    const room = subject();
    install(room, A); install(room, B);
    packet(room, A, 0, new Int16Array(FRAME * 2).fill(15_000));
    packet(room, B, 0, new Int16Array(FRAME * 2).fill(15_000));
    ready(render(room, 0));
    assert.equal(room.installAnchor(anchor(B, 0), 'content-held'), false);
    assert.equal(room.holdAnchor(B.participantId), true);
    assert.equal(room.revokeAnchor(B.participantId), true);
    const frame = ready(render(room, FRAME));
    assert.equal(frame.singers[0].availableSamples, FRAME);
    assert.equal(frame.singers[1].availableSamples, 0);
    assert.equal(room.holdAnchor(B.participantId), false);
  });

  test('Sample/YouTube fallback candidate drives B read position only after explicit conversion', () => {
    const room = subject();
    install(room, A);
    room.addSinger(B);
    const identity: ChoirCalibrationIdentity = {
      participantId: B.participantId, songEpoch: SONG, videoId: 'abcdefghijk',
      micGeneration: B.captureGeneration, backingGeneration: BACKING,
      roomGeneration: 1, robotSourceGeneration: 1,
      micSourceRate: RATE, backingSourceRate: RATE,
    };
    const calibrations = new ChoirCalibrationExperiment();
    calibrations.activate(identity);
    for (let i = 0; i < 3; i++) {
      const now = 1000 + i * 250;
      const backing: SongSampleAnchor = {
        videoId: identity.videoId, generation: BACKING, sampleRate: RATE,
        sampleIndex: Math.round((.5 + i * .25) * RATE),
        mediaSeconds: 10 + i * .25, playbackRate: 1, state: 1, uncertaintyMs: 20,
      };
      const mic: SongSampleAnchor = {
        ...backing, generation: B.captureGeneration,
        sampleIndex: Math.round((.8 + i * .25) * RATE),
      };
      calibrations.observeSample(identity, 'backing', backing, now);
      calibrations.observeSample(identity, 'mic', mic, now);
    }
    const decision = calibrations.resolve({
      identity, nowMs: 1500, contentApplicability: 'apply',
      sampleMap: (_, a) => a.sampleIndex, sessionSampleRate: RATE,
      playbackRate: 1,
    });
    assert.equal(decision?.source, 'sample-song-estimate');
    assert.ok(Math.abs(decision!.advanceMs! - 300) < .001);

    const conversion = choirAnchorFromDecision({
      participantId: B.participantId,
      songEpoch: SONG, captureGeneration: B.captureGeneration,
      backingGeneration: BACKING, roomSampleRate: RATE,
      micSampleRate: RATE, roomSampleAtAnchor: 0,
      zeroAdvanceNativeMicSample: 0, decision: decision!,
    });
    assert.ok(conversion);
    assert.equal(room.installAnchor(conversion!.anchor, conversion!.source), true);
    const mark = new Int16Array(FRAME);
    mark[300] = 20_000;
    packet(room, A, 0, mark);
    packet(room, B, 14_400, mark);
    const frame = ready(render(room, 0));
    assert.equal(frame.singers[1].calibration, 'sample-song-estimate');
    assert.equal(frame.singers[1].availableSamples, FRAME);
    assert.ok(frame.pcm[300] > 1_000);
  });
});
