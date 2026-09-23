import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;

function frame(pcm: Buffer): PcmFrame {
  return { generation: 1, firstSampleIndex: 0, pcm };
}

function tone(seconds: number, hz: number, amplitude: number) {
  const samples = Math.round(RATE * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));
    pcm.writeInt16LE(value, i * 2);
  }
  return pcm;
}

function makeSession() {
  return new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 0.65,
    retentionMs: 3_000,
    backingRetentionMs: 1_000,
  });
}

describe('AudioSession runtime calibration slew', () => {
  test('validated drift moves the live read head gradually instead of jumping', () => {
    const session = makeSession();
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });

    assert.equal(session.slewCalibratedMicLagTo(160), true);
    assert.equal(session.alignment.calibratedMicLagMs, 100, 'setting a target must not jump the live read head');
    assert.equal(session.calibratedMicLagTarget, 160);

    session.drain(() => {}, 0, 1);
    const firstStep = session.alignment.calibratedMicLagMs!;
    assert.ok(firstStep > 100 && firstStep < 101, `first frame jumped to ${firstStep} ms`);

    session.drain(() => {}, 6_000, 1_000);
    assert.ok(
      Math.abs(session.alignment.calibratedMicLagMs! - 160) < 1e-9,
      `slew stopped at ${session.alignment.calibratedMicLagMs} ms`,
    );
  });

  test('validated drift changes Mic read rate instead of splicing every 20 ms frame', () => {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: 20,
      prebufferMs: 600,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 1_000,
    });
    session.setMicGainDb(0);
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });
    session.ingestMic(frame(tone(2, 1_000, 10_000)), RATE, 0);

    const mixed: Buffer[] = [];
    session.drain((pcm) => mixed.push(pcm), 600, 1);
    assert.equal(mixed.length, 1);

    assert.equal(session.slewCalibratedMicLagTo(160), true);
    session.drain((pcm) => mixed.push(pcm), 620, 1);
    assert.equal(mixed.length, 2);

    const before = mixed[0].readInt16LE((RATE * 0.02 - 1) * 2);
    const after = mixed[1].readInt16LE(0);
    const boundaryStep = Math.abs(after - before);

    // At 48 kHz the 1% policy moves about 9.6 source samples per 20 ms.
    // Applying that as an integer frame-start jump makes this 1 kHz tone leap
    // by roughly 11k counts at the boundary. A real read-rate slew keeps the
    // boundary at the tone's ordinary one-sample derivative instead.
    assert.ok(
      boundaryStep < 3_000,
      `runtime correction spliced the Mic waveform at the frame boundary: ${boundaryStep}`,
    );
    assert.ok(
      Math.abs((session.alignment.calibratedMicLagMs ?? 0) - 100.2) < 1e-9,
      'audio continuity must not change the existing 1% timing policy',
    );
  });

  test('bounded slew carries gap evidence along the exact interpolated source trajectory', () => {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: 20,
      prebufferMs: 600,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 1_000,
    });
    session.setMicGainDb(0);
    session.setMicExpected(true);
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });

    // Frame 0 reads source samples 4800..5759. The next 1% runtime-slew frame
    // begins on source sample 5760 but ends at a rounded +100.2 ms read head
    // (sample 5770). Put a tiny real hole only in that 10-sample disagreement:
    // the audio interpolator must traverse it even though a plain micReadStart
    // evidence lookup would begin after it and report the frame as complete.
    const gapStart = 5_760;
    const gapEnd = 5_768;
    const before = Buffer.alloc(gapStart * 2);
    before.fill(0);
    for (let index = 0; index < gapStart; index += 1) before.writeInt16LE(8_000, index * 2);
    const afterCount = RATE - gapEnd;
    const after = Buffer.alloc(afterCount * 2);
    for (let index = 0; index < afterCount; index += 1) after.writeInt16LE(8_000, index * 2);

    session.ingestMic({ generation: 1, firstSampleIndex: 0, pcm: before }, RATE, 0);
    session.ingestMic({ generation: 1, firstSampleIndex: gapEnd, pcm: after }, RATE, 0);

    const evidence: Array<{
      micGapSamples: number;
      micStarvedSamples: number;
    }> = [];
    session.drain((_pcm, frameEvidence) => evidence.push(frameEvidence), 600, 1);
    assert.equal(evidence[0]?.micGapSamples, 0);

    assert.equal(session.slewCalibratedMicLagTo(160), true);
    session.drain((_pcm, frameEvidence) => evidence.push(frameEvidence), 620, 1);

    assert.equal(session.alignment.calibratedMicLagMs, 100.2);
    assert.equal(
      evidence[1]?.micGapSamples,
      8,
      'every emitted sample whose interpolation touches the positioned hole must remain gap evidence',
    );
    assert.equal(evidence[1]?.micStarvedSamples, 0);
  });

  test('bounded slew does not interpolate across a Mic capture-restart boundary', () => {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: 20,
      prebufferMs: 600,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 1_000,
    });
    session.setMicGainDb(0);
    session.setMicExpected(true);
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });

    const constant = (count: number, value: number) => {
      const pcm = Buffer.alloc(count * 2);
      for (let index = 0; index < count; index += 1) pcm.writeInt16LE(value, index * 2);
      return pcm;
    };

    // Put the semantic capture boundary at source sample 5765. During the
    // second output frame the 1% slew reads 5764.04 just before crossing it.
    // Linear interpolation would blend old +12k PCM with new -12k PCM even
    // though those captures have no waveform-continuity authority.
    const boundary = 5_765;
    session.ingestMic(
      { generation: 1, firstSampleIndex: 0, pcm: constant(boundary, 12_000) },
      RATE,
      0,
    );
    const firstReplacementSamples = 960;
    const restartNowMs = ((boundary + firstReplacementSamples) * 1_000) / RATE;
    session.ingestMic(
      {
        generation: 2,
        firstSampleIndex: 0,
        pcm: constant(firstReplacementSamples, -12_000),
      },
      RATE,
      restartNowMs,
    );
    session.ingestMic(
      {
        generation: 2,
        firstSampleIndex: firstReplacementSamples,
        pcm: constant(RATE, -12_000),
      },
      RATE,
      restartNowMs + 20,
    );

    const mixed: Buffer[] = [];
    session.drain((pcm) => mixed.push(pcm), 600, 1);
    assert.equal(mixed.length, 1);

    session.slewCalibratedMicLagTo(160);
    session.drain((pcm) => mixed.push(pcm), 620, 1);
    assert.equal(mixed.length, 2);

    const beforeBoundary = mixed[1].readInt16LE(4 * 2);
    assert.ok(
      Math.abs(beforeBoundary - 12_000) <= 1,
      `slew interpolated across a semantic capture restart before crossing it: ${beforeBoundary}`,
    );

    const firstAfterBoundary = mixed[1].readInt16LE(5 * 2);
    assert.ok(
      Math.abs(firstAfterBoundary - beforeBoundary) <= 1,
      'the existing replacement fade should own the first post-restart sample',
    );
  });

  test('immediate live alignment jump crossfades instead of splicing the Mic', () => {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: 20,
      prebufferMs: 600,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 1_000,
    });
    session.setMicGainDb(0);
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });
    session.ingestMic(frame(tone(3, 997, 10_000)), RATE, 0);

    const mixed: Buffer[] = [];
    session.drain((pcm) => mixed.push(pcm), 600, 1);
    assert.equal(mixed.length, 1);

    // Robot/content authority can legitimately replace the live lag in one
    // transaction. Keep that authority immediate, but do not splice the old
    // waveform directly to a source point 137 ms away.
    session.setAlignment({ calibratedMicLagMs: 237 });
    assert.equal(session.alignment.calibratedMicLagMs, 237);
    session.drain((pcm) => mixed.push(pcm), 620, 1);
    assert.equal(mixed.length, 2);

    const frameSamples = Math.round(RATE * 0.02);
    const before = mixed[0].readInt16LE((frameSamples - 1) * 2);
    const after = mixed[1].readInt16LE(0);
    const boundaryStep = Math.abs(after - before);

    // Without the transition the 997 Hz fixture jumps by roughly 16.7k PCM
    // counts here. Continuing the old trajectory for the first crossfade sample
    // keeps the boundary inside the tone's ordinary one-sample derivative.
    assert.ok(
      boundaryStep < 3_000,
      `immediate alignment spliced the Mic waveform at the frame boundary: ${boundaryStep}`,
    );
    assert.equal(
      session.appliedMicAdvanceMs,
      237,
      'crossfade must not turn immediate authority into a slow timing slew',
    );
  });

  test('immediate read-head crossfade never counts more unheadered samples than it emits', () => {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: 20,
      prebufferMs: 600,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 1_000,
    });
    session.setMicGainDb(0);
    session.setMicExpected(true);
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });

    // Legacy PCM has no source positions, so every emitted Mic sample in this
    // fixture is unheadered. The immediate-jump crossfade used to compare a
    // 242-sample old interpolation window with a 240-sample new window and add
    // that two-sample lookahead difference on top of the 960 emitted samples.
    session.ingestMic(
      { generation: null, firstSampleIndex: null, pcm: tone(3, 997, 8_000) },
      RATE,
      0,
    );

    const evidence: Array<{ unheaderedSamples: number }> = [];
    session.drain((_pcm, frameEvidence) => evidence.push(frameEvidence), 600, 1);
    assert.equal(evidence[0]?.unheaderedSamples, 960);

    session.setAlignment({ calibratedMicLagMs: 237 });
    session.drain((_pcm, frameEvidence) => evidence.push(frameEvidence), 620, 1);

    assert.equal(
      evidence[1]?.unheaderedSamples,
      960,
      'interpolation lookahead is not an emitted sample and must not inflate Take evidence',
    );
  });

  test('immediate read-head crossfade does not leak across a retained Mic capture restart', () => {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: 20,
      prebufferMs: 600,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 1_000,
    });
    session.setMicGainDb(0);
    session.setMicExpected(true);
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });

    const constant = (count: number, value: number) => {
      const pcm = Buffer.alloc(count * 2);
      for (let index = 0; index < count; index += 1) pcm.writeInt16LE(value, index * 2);
      return pcm;
    };

    // The first emitted frame ends at source 5759. Keep one more old-capture
    // sample, then start a replacement capture with opposite polarity at 5761.
    // On the next frame the old crossfade leg starts at 5760 and would enter
    // the replacement on its second sample. The new immediate read head is
    // pulled 6 ms backward to 5472, so the authoritative trajectory itself
    // remains entirely on the old capture during the 5 ms crossfade.
    const boundary = 5_761;
    session.ingestMic(
      { generation: 1, firstSampleIndex: 0, pcm: constant(boundary, 12_000) },
      RATE,
      0,
    );
    const firstReplacementSamples = 960;
    const restartNowMs = ((boundary + firstReplacementSamples) * 1_000) / RATE;
    session.ingestMic(
      {
        generation: 2,
        firstSampleIndex: 0,
        pcm: constant(firstReplacementSamples, -12_000),
      },
      RATE,
      restartNowMs,
    );
    session.ingestMic(
      {
        generation: 2,
        firstSampleIndex: firstReplacementSamples,
        pcm: constant(RATE, -12_000),
      },
      RATE,
      restartNowMs + 20,
    );

    const mixed: Buffer[] = [];
    session.drain((pcm) => mixed.push(pcm), 600, 1);
    assert.equal(mixed.length, 1);

    // A 6 ms immediate authority change is far beyond the bounded 1% slew
    // budget, so it uses the 5 ms read-head crossfade.
    session.setAlignment({ calibratedMicLagMs: 94 });
    session.drain((pcm) => mixed.push(pcm), 620, 1);
    assert.equal(mixed.length, 2);

    const first = mixed[1].readInt16LE(0);
    const second = mixed[1].readInt16LE(2);
    assert.ok(Math.abs(first - 12_000) <= 1);
    assert.ok(
      Math.abs(second - first) <= 1,
      `old crossfade leg leaked across retained capture restart: ${first} -> ${second}`,
    );

    let maximumStep = 0;
    for (let index = 1; index < Math.round(RATE * 0.005); index += 1) {
      maximumStep = Math.max(
        maximumStep,
        Math.abs(mixed[1].readInt16LE(index * 2) - mixed[1].readInt16LE((index - 1) * 2)),
      );
    }
    assert.ok(
      maximumStep < 500,
      `retained restart contaminated the alignment crossfade by ${maximumStep} PCM counts`,
    );
  });

  test('fine-tune authority during a runtime slew crossfades from the actually emitted read head', () => {
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: 20,
      prebufferMs: 600,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 1_000,
    });
    session.setMicGainDb(0);
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100, fineTuneMs: -25 });
    session.ingestMic(frame(tone(3, 997, 8_000)), RATE, 0);

    const mixed: Buffer[] = [];
    session.drain((pcm) => mixed.push(pcm), 600, 1);

    // Establish a real bounded runtime trajectory on both sides of the target.
    session.slewCalibratedMicLagTo(141);
    session.drain((pcm) => mixed.push(pcm), 620, 1);
    session.slewCalibratedMicLagTo(73);
    session.drain((pcm) => mixed.push(pcm), 640, 1);

    // fineTune is immediate authority. The previous implementation recomputed
    // the "old" read head with this new fine tune and therefore mistook the
    // ~41 ms jump for the remaining 0.2 ms calibration slew.
    session.setAlignment({ fineTuneMs: 16 });
    session.drain((pcm) => mixed.push(pcm), 660, 1);
    assert.equal(mixed.length, 4);

    const frameSamples = Math.round(RATE * 0.02);
    const before = mixed[2].readInt16LE((frameSamples - 1) * 2);
    const after = mixed[3].readInt16LE(0);
    const boundaryStep = Math.abs(after - before);
    assert.ok(
      boundaryStep < 3_000,
      `fine-tune authority spliced the Mic while calibration was slewing: ${boundaryStep}`,
    );
    assert.ok(
      session.appliedMicAdvanceMs < 90,
      `fine-tune authority must remain immediate, saw ${session.appliedMicAdvanceMs} ms`,
    );
  });

  test('ordinary setAlignment remains immediate and cancels a pending runtime target', () => {
    const session = makeSession();
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });
    session.slewCalibratedMicLagTo(160);

    session.setAlignment({ calibratedMicLagMs: 80 });

    assert.equal(session.alignment.calibratedMicLagMs, 80);
    assert.equal(session.calibratedMicLagTarget, 80);
    session.drain(() => {}, 0, 1);
    assert.equal(session.alignment.calibratedMicLagMs, 80, 'manual/robot-style immediate alignment must not keep slewing');
  });

  test('a new mix epoch cannot continue an old runtime target', () => {
    const session = makeSession();
    session.start(0);
    session.setAlignment({ calibratedMicLagMs: 100 });
    session.slewCalibratedMicLagTo(160);

    session.resetEpoch(1_000);

    assert.equal(session.calibratedMicLagTarget, 100);
    session.drain(() => {}, 1_000, 1);
    assert.equal(session.alignment.calibratedMicLagMs, 100);
  });
});
