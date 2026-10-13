import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ChoirAudioPrototype, type ChoirAudioIdentity } from '../src/choir-audio-prototype.js';
import { ChoirSession } from '../src/choir-session.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';
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
    songEpoch: id.songEpoch, backingGeneration: id.backingGeneration,
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
      participantId: A.participantId, songEpoch: SONG, backingGeneration: BACKING,
      captureGeneration: 15, firstSampleIndex: 0, pcm: new Int16Array(FRAME),
    }), 'invalid');
    assert.throws(() => room.render({
      roomStartSample: 0, nowRoomSample: FRAME + HOLD, songEpoch: SONG + 1,
      backingGeneration: BACKING, backing: new Int16Array(FRAME),
    }), /room epoch/);
    assert.equal(ready(render(room, 0)).singers[0].availableSamples, FRAME);
    assert.equal(room.addSinger({ ...B, songEpoch: SONG + 1 }), false);
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
    // A discontinuous huge future packet must NOT poison the ring frontier.
    assert.equal(packet(room, A, 300_000, new Int16Array(FRAME).fill(9_000)), 'invalid');
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

  test('a song/backing restart requires a new room epoch; old packets cannot contaminate it', () => {
    const oldRoom = subject();
    install(oldRoom, A);
    assert.equal(oldRoom.addSinger({ ...A, songEpoch: SONG + 1 }), false,
      'the existing room cannot silently replace the authoritative song');
    assert.equal(oldRoom.addSinger({ ...B, backingGeneration: BACKING + 1 }), false);

    // The experimental prototype requires an explicit new room instance.
    // There is intentionally no implicit attempt to splice incompatible
    // song and backing epochs while its output head is still running.
    const newRoom = subject();
    const newIdentity = { ...A, songEpoch: SONG + 1, backingGeneration: BACKING + 1 };
    assert.equal(newRoom.addSinger(newIdentity), true);
    assert.equal(packet(newRoom, A, 0, new Int16Array(FRAME)), 'invalid');
    assert.equal(newRoom.receiveMic({
      participantId: A.participantId, songEpoch: SONG + 1,
      backingGeneration: BACKING + 1, captureGeneration: A.captureGeneration,
      firstSampleIndex: 0, pcm: new Int16Array(FRAME),
    }), 'accepted');
    assert.equal(newRoom.installAnchor(anchor(A, 0), 'content'), false);
  });

  test('giant packets and implausible rates cannot exhaust the native PCM ring', () => {
    const room = subject();
    assert.equal(room.addSinger({ ...A, micSampleRate: 10_000_000 }), false);
    install(room, A);
    assert.equal(packet(room, A, 0, new Int16Array(RATE * 3)), 'invalid');
  });

  test('ring keeps a newer sample when an older out-of-order packet shares its slot', () => {
    const room = subject({ retentionMs: 150 });
    install(room, A, 7200);
    const newer = new Int16Array(FRAME).fill(12_000);
    const old = new Int16Array(FRAME).fill(-12_000);
    assert.equal(packet(room, A, 7200, newer), 'accepted');
    assert.equal(packet(room, A, 200, old), 'accepted');
    const frame = ready(render(room, 0));
    assert.equal(frame.singers[0].availableSamples, FRAME);
    assert.ok(frame.pcm[500] > 0, 'out-of-order packet did not corrupt future audio');
  });

  test('far-future mic timestamp cannot evict audio that is still scheduled', () => {
    const room = subject({ retentionMs: 150 });
    install(room, A);
    assert.equal(packet(room, A, 0, new Int16Array(FRAME * 2).fill(13_000)), 'accepted');
    assert.equal(packet(room, A, 300_000, new Int16Array(FRAME).fill(25_000)), 'invalid');
    const first = ready(render(room, 0));
    assert.equal(first.singers[0].availableSamples, FRAME);
    assert.equal(first.singers[0].missingSamples, 0);
    const second = ready(render(room, FRAME));
    assert.equal(second.singers[0].availableSamples, FRAME);
  });

  test('identical confirmed re-application does not silence a stable voice', () => {
    const room = subject();
    install(room, A);
    packet(room, A, 0, new Int16Array(FRAME * 3).fill(13_000));
    ready(render(room, 0));
    assert.equal(room.installAnchor(anchor(A, 0), 'content'), true);
    const unchanged = ready(render(room, FRAME));
    assert.equal(unchanged.singers[0].availableSamples, FRAME);
    assert.ok(unchanged.pcm[0] > 1000,
      'same anchor must not restart the 10ms fade on next frame');
  });

  test('unsafe backup jump cannot replace confirmed Content mid-song', () => {
    const room = subject();
    install(room, A);
    packet(room, A, 0, new Int16Array(FRAME * 3).fill(13_000));
    ready(render(room, 0));
    assert.equal(room.installAnchor(anchor(A, 17_280), 'sample-song-estimate'), false,
      '360ms read-head jump requires explicit revalidation, not a live jump');
    const frame = ready(render(room, FRAME));
    assert.equal(frame.singers[0].calibration, 'content');
    assert.equal(frame.singers[0].availableSamples, FRAME);
  });

  test('small anchor changes fade the existing voice out before switching only that singer', () => {
    const room = subject();
    install(room, A);
    install(room, B);
    packet(room, A, 0, new Int16Array(FRAME * 4).fill(19_000));
    packet(room, B, 0, new Int16Array(FRAME * 4).fill(19_000));
    ready(render(room, 0));
    assert.equal(room.installAnchor(anchor(B, 96), 'sample-song-estimate'), true,
      '2ms change is allowed, but should not install with a hard cut');
    const fading = ready(render(room, FRAME));
    assert.equal(fading.singers[0].availableSamples, FRAME);
    assert.equal(fading.singers[1].calibration, 'content',
      'B still reads the old position while fading down');
    const resumed = ready(render(room, FRAME * 2));
    assert.equal(resumed.singers[0].calibration, 'content');
    assert.equal(resumed.singers[1].calibration, 'sample-song-estimate');
    assert.equal(resumed.singers[0].availableSamples, FRAME);
    assert.equal(resumed.singers[1].availableSamples, FRAME);
  });

  test('revoking the last mic keeps a short output tail before releasing bus headroom', () => {
    const room = subject();
    install(room, A);
    packet(room, A, 0, new Int16Array(FRAME * 3).fill(15_000));
    ready(render(room, 0));
    assert.equal(room.revokeAnchor(A.participantId), true);
    const trailing = ready(render(room, FRAME));
    assert.equal(trailing.singers[0].availableSamples, 0);
    assert.ok(trailing.pcm[0] > trailing.pcm[FRAME - 1],
      'mic output decays instead of cutting immediately to zero');
    assert.equal(room.holdAnchor(A.participantId), false);
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

describe('end-to-end experimental Content > accepted calibration > native read > audio', () => {
  test('real Content algorithm drives two audible Mic tracks while A remains controller', () => {
    const seats = new ChoirSession();
    assert.equal(seats.claimPrimary(A.participantId, null).ok, true);
    assert.equal(seats.joinSecondary(B.participantId).ok, true);

    const model = new ChoirCalibrationExperiment();
    const aIdentity: ChoirCalibrationIdentity = {
      participantId: A.participantId, videoId: 'abcdefghijk', songEpoch: SONG,
      micGeneration: A.captureGeneration, backingGeneration: BACKING,
      roomGeneration: 4, robotSourceGeneration: 9,
      micSourceRate: RATE, backingSourceRate: RATE,
    };
    const bIdentity: ChoirCalibrationIdentity = {
      ...aIdentity, participantId: B.participantId, micGeneration: B.captureGeneration,
    };
    assert.equal(model.activate(aIdentity), true);
    assert.equal(model.activate(bIdentity), true);

    const as = laggedMultibandMusicPair(6, RATE, 120, { singerGain: .12 });
    const bs = laggedMultibandMusicPair(6, RATE, -340, { singerGain: .08 });
    const view = (buf: Buffer) => new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    const ca = model.analyzeContent(aIdentity, view(as.mic), view(as.backing), RATE);
    const cb = model.analyzeContent(bIdentity, view(bs.mic), view(bs.backing), RATE);
    assert.equal(ca.status, 'candidate');
    assert.equal(cb.status, 'candidate');
    if (ca.status !== 'candidate' || cb.status !== 'candidate') return;
    assert.ok(Math.abs(ca.candidate.result.micLagMs - 120) <= 25);
    assert.ok(Math.abs(cb.candidate.result.micLagMs + 340) <= 25);
    assert.equal(model.confirmContent(ca.candidate, true), true);
    assert.equal(model.confirmContent(cb.candidate, true), true);

    const room = subject();
    assert.equal(room.addSinger(A), true);
    assert.equal(room.addSinger(B), true);
    for (const [id, identity] of [[A, aIdentity], [B, bIdentity]] as const) {
      const decision = model.resolve({
        identity, nowMs: 1800, contentApplicability: 'apply',
        sampleMap: (_, x) => x.sampleIndex, sessionSampleRate: RATE, playbackRate: 1,
      });
      assert.equal(decision?.source, 'content');
      const converted = choirAnchorFromDecision({
        participantId: id.participantId, songEpoch: SONG,
        captureGeneration: id.captureGeneration, backingGeneration: BACKING,
        roomSampleRate: RATE, micSampleRate: RATE,
        roomSampleAtAnchor: 0, zeroAdvanceNativeMicSample: RATE / 2,
        decision: decision!,
      });
      assert.ok(converted);
      assert.equal(room.installAnchor(converted!.anchor, converted!.source), true);
      const signal = new Int16Array(FRAME);
      signal[400] = 20_000;
      // Fractional results can be sub-sample. The source reader handles them.
      const nativeFirst = Math.floor(converted!.anchor.micSampleAtAnchor);
      // Two input samples cover the interpolated output at the impulse.
      signal[400] = 20_000;
      assert.equal(packet(room, id, nativeFirst, signal), 'accepted');
    }

    const frame = ready(render(room, 0));
    assert.deepEqual(frame.singers.map(s => s.calibration), ['content', 'content']);
    assert.ok(frame.singers.every(s => s.availableSamples >= FRAME - 1));
    assert.ok(Math.max(...frame.pcm) > 1_000);

    assert.equal(seats.leaveSinger(A.participantId).ok, true);
    room.removeSinger(A.participantId);
    assert.equal(seats.snapshot().primaryMicId, null, 'no automatic main succession');
    assert.equal(seats.seatOf(B.participantId), 'secondary');
    assert.equal(seats.songControllerId, A.participantId, 'song control stays independent');
    const next = ready(render(room, FRAME));
    assert.deepEqual(next.singers.map(s => s.participantId), [B.participantId]);
  });
});

describe('adversarial end-to-end check: microphone event timestamps are independent of estimator', () => {
  test('real Content lags put A/B independently timestamped PCM transients into the same room window', () => {
    const trueLags = [
      { id: A, lag: 120 },
      { id: B, lag: -340 },
    ] as const;
    const roomEventSample = 3 * FRAME + 400;
    const zeroAdvanceNativeMicSample = RATE;
    const outputs: number[] = [];
    const view = (buffer: Buffer) => new Int16Array(
      buffer.buffer, buffer.byteOffset, buffer.byteLength / 2,
    );

    for (const singer of trueLags) {
      // Ground truth comes from fixture construction, NOT from the estimate.
      const synthetic = laggedMultibandMusicPair(6, RATE, singer.lag, { singerGain: 0.1 });
      const calibration = new ChoirCalibrationExperiment();
      const identity: ChoirCalibrationIdentity = {
        participantId: singer.id.participantId, videoId: 'abcdefghijk',
        songEpoch: SONG, micGeneration: singer.id.captureGeneration,
        backingGeneration: BACKING, roomGeneration: 3,
        robotSourceGeneration: 5, micSourceRate: RATE, backingSourceRate: RATE,
      };
      assert.equal(calibration.activate(identity), true);
      const candidate = calibration.analyzeContent(
        identity, view(synthetic.mic), view(synthetic.backing), RATE,
      );
      assert.equal(candidate.status, 'candidate');
      if (candidate.status !== 'candidate') return;
      assert.equal(calibration.confirmContent(candidate.candidate, true), true);
      const decision = calibration.resolve({
        identity, nowMs: 10_000, contentApplicability: 'apply',
        sampleMap: (_, anchor) => anchor.sampleIndex,
        sessionSampleRate: RATE, playbackRate: 1,
      });
      assert.equal(decision?.source, 'content');
      const converted = choirAnchorFromDecision({
        participantId: singer.id.participantId, songEpoch: SONG,
        captureGeneration: singer.id.captureGeneration, backingGeneration: BACKING,
        roomSampleRate: RATE, micSampleRate: RATE, roomSampleAtAnchor: 0,
        zeroAdvanceNativeMicSample, decision: decision!,
      });
      assert.ok(converted);

      const room = subject();
      assert.equal(room.addSinger(singer.id), true);
      assert.equal(room.installAnchor(converted!.anchor, 'content'), true);

      const nativeFirstSample = 20_000;
      const source = new Int16Array(65_000);
      const trueNativeEvent = zeroAdvanceNativeMicSample
        + Math.round(singer.lag * RATE / 1000) + roomEventSample;
      source[trueNativeEvent - nativeFirstSample] = 24_000;
      assert.equal(packet(room, singer.id, nativeFirstSample, source), 'accepted');

      const mixed = new Int16Array(8 * FRAME);
      for (let frame = 0; frame < 8; frame++) {
        const rendered = ready(render(room, frame * FRAME));
        mixed.set(rendered.pcm, frame * FRAME);
      }
      let peakSample = 0;
      for (let i = 1; i < mixed.length; i++) {
        if (Math.abs(mixed[i]) > Math.abs(mixed[peakSample])) peakSample = i;
      }
      assert.ok(Math.abs(mixed[peakSample]) > 500, 'real PCM transient was rendered');
      assert.ok(
        Math.abs(peakSample - roomEventSample) <= RATE * 0.025,
        `independent truth ${singer.lag}ms: expected room event ${roomEventSample}, got ${peakSample}`,
      );
      outputs.push(peakSample);
    }
    assert.equal(outputs.length, 2);
    assert.ok(Math.abs(outputs[0] - outputs[1]) <= RATE * 0.03,
      `the voices must coincide within 30ms: ${outputs.join(', ')}`);
  });
});
