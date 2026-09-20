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
