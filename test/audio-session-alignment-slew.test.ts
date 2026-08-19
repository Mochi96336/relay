import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';

function makeSession() {
  return new AudioSession({
    sampleRate: 48_000,
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
