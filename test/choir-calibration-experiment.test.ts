import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ChoirCalibrationExperiment, type ChoirCalibrationIdentity } from '../src/choir-calibration-experiment.js';
import type { SongSampleAnchor } from '../src/sample-song-fallback.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';

const RATE = 48_000;
const VIDEO = 'abcdefghijk';
const A: ChoirCalibrationIdentity = {
  participantId: 'participant-a', videoId: VIDEO, songEpoch: 5,
  micGeneration: 2, backingGeneration: 4,
  roomGeneration: 1, robotSourceGeneration: 6,
  micSourceRate: RATE, backingSourceRate: RATE,
};
const B: ChoirCalibrationIdentity = { ...A, participantId: 'participant-b', micGeneration: 3 };

function int16(buffer: Buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
}

/**
 * Produce two *different* singer tracks cut from ONE shared song, rather than
 * unrelated backing fixtures. This makes the reported lag a known ground truth.
 * A positive lag means the mic content starts earlier in the song than backing.
 */
function singerTrack(master: Buffer, backingStart: number, lagMs: number, singerHz: number) {
  const sampleShift = Math.round(lagMs * RATE / 1000);
  const start = backingStart - sampleShift;
  const samples = RATE * 6;
  const output = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const music = master.readInt16LE((start + i) * 2) / 32768;
    const seconds = i / RATE;
    const envelope = 0.12 * (0.4 + 0.6 * Math.sin(2 * Math.PI * 1.7 * seconds) ** 2);
    const voice = Math.sin(2 * Math.PI * singerHz * seconds) * envelope;
    const value = Math.max(-1, Math.min(1, music * 0.62 + voice));
    output.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return output;
}

function observation(side: 'mic' | 'backing', i: number, offsetSeconds: number): SongSampleAnchor {
  return {
    videoId: VIDEO, generation: side === 'mic' ? A.micGeneration : A.backingGeneration,
    sampleRate: RATE, sampleIndex: Math.round((i * .25 + offsetSeconds) * RATE),
    mediaSeconds: 10 + i * .25, playbackRate: 1, state: 1, uncertaintyMs: 20,
  };
}

function seedSample(
  model: ChoirCalibrationExperiment,
  identity: ChoirCalibrationIdentity,
  micOffsetSeconds: number,
  backingOffsetSeconds = .5,
) {
  for (let i = 0; i < 3; i++) {
    const nowMs = 1000 + i * 250;
    assert.equal(model.observeSample(identity, 'backing', observation('backing', i, backingOffsetSeconds), nowMs), true);
    assert.equal(model.observeSample(identity, 'mic', {
      ...observation('mic', i, micOffsetSeconds), generation: identity.micGeneration,
    }, nowMs), true);
  }
}

function choice(model: ChoirCalibrationExperiment, identity: ChoirCalibrationIdentity, extra: {
  contentApplicability?: 'apply' | 'hold' | 'revoke';
  nowMs?: number;
  preference?: 'sample-song' | 'boot-probe';
  freshRobotDeltaMs?: number | null;
  playbackRate?: number;
} = {}) {
  return model.resolve({
    identity, nowMs: extra.nowMs ?? 1500,
    contentApplicability: extra.contentApplicability ?? 'apply',
    sampleMap: (_, anchor) => anchor.sampleIndex,
    sessionSampleRate: RATE,
    freshRobotDeltaMs: extra.freshRobotDeltaMs,
    playbackRate: extra.playbackRate ?? 1,
    preference: extra.preference,
  });
}

describe('dual-singer real Content plus separate fallback strategies', () => {
  test('real Content analyzer independently recovers +120 and -340 ms against one backing PCM', () => {
    const model = new ChoirCalibrationExperiment();
    model.activate(A);
    model.activate(B);
    const { backing: master } = laggedMultibandMusicPair(8, RATE, 0);
    const start = RATE;
    const backing = master.subarray(start * 2, (start + RATE * 6) * 2);
    const micA = singerTrack(master, start, 120, 207);
    const micB = singerTrack(master, start, -340, 293);
    const a = model.analyzeContent(A, int16(micA), int16(backing), RATE);
    const b = model.analyzeContent(B, int16(micB), int16(backing), RATE);
    assert.equal(a.status, 'candidate', JSON.stringify(a));
    assert.equal(b.status, 'candidate', JSON.stringify(b));
    if (a.status !== 'candidate' || b.status !== 'candidate') return;
    assert.ok(Math.abs(a.candidate.result.micLagMs - 120) <= 25, `A: ${a.candidate.result.micLagMs}`);
    assert.ok(Math.abs(b.candidate.result.micLagMs + 340) <= 25, `B: ${b.candidate.result.micLagMs}`);
    assert.equal(choice(model, A)?.source, 'unavailable', 'analyzer output alone is not authority');
    assert.equal(model.confirmContent(a.candidate, false), false, 'external validation is required');
    assert.equal(model.confirmContent(a.candidate, true), false, 'a rejected candidate cannot be replayed');
    const accepted = model.analyzeContent(A, int16(micA), int16(backing), RATE);
    assert.equal(accepted.status, 'candidate');
    if (accepted.status !== 'candidate') return;
    assert.equal(model.confirmContent(accepted.candidate, true), true);
    assert.equal(model.confirmContent(b.candidate, true), true);
    assert.equal(choice(model, A)?.source, 'content');
    assert.equal(choice(model, B)?.source, 'content');
  });

  test('Sample/YouTube is separate for each singer and cannot overwrite confirmed Content', () => {
    const model = new ChoirCalibrationExperiment();
    model.activate(A);
    model.activate(B);
    seedSample(model, A, .62);  // +120 ms fallback
    seedSample(model, B, .16);  // -340 ms fallback
    assert.equal(choice(model, A)?.source, 'sample-song-estimate');
    assert.ok(Math.abs(choice(model, A)!.advanceMs! - 120) < 1e-6);
    assert.equal(choice(model, B)?.source, 'sample-song-estimate');
    assert.ok(Math.abs(choice(model, B)!.advanceMs! + 340) < 1e-6);

    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 120);
    const confirmed = model.analyzeContent(A, int16(mic), int16(backing), RATE);
    assert.equal(confirmed.status, 'candidate');
    if (confirmed.status !== 'candidate') return;
    assert.equal(model.confirmContent(confirmed.candidate, true), true);
    assert.equal(choice(model, A)?.source, 'content');
    assert.ok(Math.abs(choice(model, A)!.sampleResidualMs!) <= 25);

    // A failed retry must not destroy already confirmed content authority.
    const retry = model.analyzeContent(A, new Int16Array(RATE * 6), int16(backing), RATE);
    assert.equal(retry.status, 'rejected');
    assert.equal(choice(model, A)?.source, 'content');
    assert.equal(choice(model, A, { contentApplicability: 'hold' })?.source, 'content-held');

    // Once authoritative mapping revokes Content, a *fresh* Sample candidate
    // remains available, but is explicitly labeled as an estimate.
    assert.equal(choice(model, A, { contentApplicability: 'revoke' })?.source, 'sample-song-estimate');
    assert.equal(choice(model, A)?.source, 'sample-song-estimate',
      'a revoked Content candidate cannot silently revive at the next query');
    assert.equal(choice(model, B)?.source, 'sample-song-estimate');
  });

  test('Sample fallback expires and mismatched song/capture epochs cannot reuse it', () => {
    const model = new ChoirCalibrationExperiment();
    model.activate(A);
    seedSample(model, A, .62);
    assert.equal(choice(model, A, { nowMs: 2501 })?.source, 'unavailable');
    assert.equal(model.observeSample(A, 'mic', { ...observation('mic', 3, .62), generation: 999 }, 1750), false);

    const nextA = { ...A, songEpoch: 6, micGeneration: 5 };
    assert.equal(model.activate(nextA), true);
    assert.equal(choice(model, A), null, 'stale async result cannot reset newer active identity');
    assert.equal(choice(model, nextA)?.source, 'unavailable');
    assert.equal(model.observeSample(A, 'backing', observation('backing', 3, .5), 1750), false);
    const reroutedA = { ...nextA, micSourceRate: 44_100 };
    model.activate(reroutedA);
    assert.equal(choice(model, nextA), null, 'device sample-rate change retires old calibration');
    const refreshedA = { ...reroutedA, robotSourceGeneration: 7 };
    model.activate(refreshedA);
    assert.equal(choice(model, reroutedA), null, 'Robot source replacement retires old calibration');
  });

  test('Boot arithmetic uses live Robot delta; backup order is explicit and device-specific', () => {
    const model = new ChoirCalibrationExperiment();
    model.activate(A);
    model.activate(B);
    seedSample(model, A, .62);
    const leg = (actualMs: number) => ({
      targetSample: RATE, actualSample: RATE + actualMs * RATE / 1000,
      correlation: .9,
    });
    const boot = {
      mic: leg(250), backing: leg(100), deltaMs: 20,
      sampleRate: RATE, playbackRate: 1,
    };
    assert.equal(model.observeBoot(A, boot, false, 1000), false, 'unverified probe must not be used');
    assert.equal(model.observeBoot(A, boot, true, 1000), true);
    assert.equal(model.observeBoot(B, boot, true, 1000), true);
    assert.equal(choice(model, A)?.source, 'sample-song-estimate');
    assert.equal(choice(model, B)?.source, 'unavailable', 'no fresh Robot delta and no Sample');
    assert.equal(choice(model, B, { freshRobotDeltaMs: 20 })?.source, 'boot-probe-estimate');
    assert.ok(Math.abs(choice(model, B, { freshRobotDeltaMs: 20 })!.advanceMs! - 170) < 1e-6);
    assert.equal(choice(model, A, { freshRobotDeltaMs: 20, preference: 'boot-probe' })?.source, 'boot-probe-estimate');
    assert.equal(choice(model, A, { freshRobotDeltaMs: 20, preference: 'sample-song' })?.source, 'sample-song-estimate');
    assert.equal(choice(model, A, { freshRobotDeltaMs: 40, preference: 'boot-probe', playbackRate: 2 })?.advanceMs, 170,
      'live media delta must be divided by current playback rate');
  });

  test('a later Content attempt invalidates an old pending confirmation, including after a rejected retry', () => {
    const model = new ChoirCalibrationExperiment();
    model.activate(A);
    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 120);
    const older = model.analyzeContent(A, int16(mic), int16(backing), RATE);
    assert.equal(older.status, 'candidate');
    if (older.status !== 'candidate') return;
    const newer = model.analyzeContent(A, int16(mic), int16(backing), RATE);
    assert.equal(newer.status, 'candidate');
    if (newer.status !== 'candidate') return;
    assert.equal(model.confirmContent(older.candidate, true), false);
    assert.equal(model.confirmContent(newer.candidate, true), true);
    assert.equal(choice(model, A)?.source, 'content');

    const pending = model.analyzeContent(A, int16(mic), int16(backing), RATE);
    assert.equal(pending.status, 'candidate');
    if (pending.status !== 'candidate') return;
    const rejected = model.analyzeContent(A, new Int16Array(RATE * 6), int16(backing), RATE);
    assert.equal(rejected.status, 'rejected');
    assert.equal(model.confirmContent(pending.candidate, true), false);
    assert.equal(choice(model, A)?.source, 'content', 'old confirmed Content is preserved');
  });

  test('five-minute Boot evidence expires even if Robot delta is still fresh', () => {
    const model = new ChoirCalibrationExperiment();
    model.activate(A);
    const leg = (ms: number) => ({
      targetSample: RATE, actualSample: RATE + ms * RATE / 1000, correlation: .9,
    });
    assert.equal(model.observeBoot(A, {
      mic: leg(250), backing: leg(100), deltaMs: 0,
      sampleRate: RATE, playbackRate: 1,
    }, true, 1000), true);
    assert.equal(choice(model, A, { freshRobotDeltaMs: 20, nowMs: 301_000 })?.source, 'boot-probe-estimate');
    assert.equal(choice(model, A, { freshRobotDeltaMs: 20, nowMs: 301_001 })?.source, 'unavailable');
    assert.equal(choice(model, A, { freshRobotDeltaMs: 20, nowMs: 500 })?.source, 'unavailable');
  });

  test('primary loss does not alter secondary calibration evidence', () => {
    const model = new ChoirCalibrationExperiment();
    model.activate(A);
    model.activate(B);
    seedSample(model, B, .16);
    assert.equal(model.remove(A.participantId), true);
    assert.equal(choice(model, A), null);
    assert.equal(choice(model, B)?.source, 'sample-song-estimate');
  });
});
