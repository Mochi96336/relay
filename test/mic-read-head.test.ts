import assert from 'node:assert/strict';
import test from 'node:test';
import { MicReadHead } from '../src/mic-read-head.js';

function fixture() {
  const head = new MicReadHead({ sampleRate: 1_000, frameMs: 20, slewFraction: .002,
    walkLimitMs: 20, jumpQuietWaitMs: 60 });
  let sample = 0;
  function plan(advance: number, quiet = false, safe = true) {
    return head.plan({ sampleRate: 1_000, frameSamples: 20, startSample: sample,
      previousAdvanceSamplesExact: head.emittedAdvanceSamples ?? advance,
      appliedAdvanceMs: advance, runtimeCalibrationSlewFraction: .006, readHeadCrossfadeMs: 5,
    }, 0, { mayWait: true, canKeepReading: () => safe, quiet: () => quiet });
  }
  function emit(advance: number, quiet = false, complete = true, safe = true) {
    const frame = plan(advance, quiet, safe);
    head.emittedFrame(frame, sample, complete);
    sample += 20;
    return frame;
  }
  return { head, plan, emit };
}

test('acceptance and actual emitted settlement carry distinct calibration revisions', () => {
  const f = fixture();
  f.head.setAlignment({ calibratedMicLagMs: 100 });
  f.head.acceptCalibration({ kind: 'boot-probe', revision: 1 });
  const initial = f.head.status;
  assert.equal(initial.settled, null);
  f.emit(100);
  const previous = f.head.status.settled!;
  assert.equal(previous.authority?.revision, 1);
  f.head.setAlignment({ calibratedMicLagMs: 140 });
  f.head.acceptCalibration({ kind: 'content', revision: 2 });
  f.emit(140);
  assert.equal(f.head.status.phase, 'waiting-for-quiet');
  assert.equal(f.head.status.acceptedCalibration?.revision, 2);
  assert.equal(f.head.status.renderedCalibration?.revision, 1);
  assert.equal(f.head.divergenceFrom(140, 140), 40, 'an accepted target does not hide a still-unheard correction');
  assert.equal(f.head.divergenceFrom(null, 140), null, 'missing evidence cannot invent a target');
  assert.deepEqual(f.head.status.settled, previous);
  const frame = f.plan(140, true);
  assert.equal(f.head.status.settled?.authority?.revision, 1, 'planning alone cannot acknowledge emitted audio');
  f.head.emittedFrame(frame, 40, true);
  assert.equal(f.head.status.phase, 'settled');
  assert.equal(f.head.status.settled?.authority?.revision, 2);
  assert.equal(f.head.status.renderedCalibration?.revision, 2);
  assert.equal(f.head.divergenceFrom(140, 140), 0);
  assert.equal(f.head.status.settled?.atSample, 40);
  f.emit(140);
  assert.equal(f.head.status.settled?.atSample, 40, 'periodic output cannot rewrite the first settlement frame');
  const snapshot = f.head.status;
  snapshot.settled!.authority = null;
  assert.equal(f.head.status.settled?.authority?.revision, 2, 'queries cannot mutate provenance');
});

test('a replacement jump gets its own wait and journals only after actual emission', () => {
  const f = fixture(); f.emit(0);
  f.head.setAlignment({ networkCompensationMs: 100 });
  f.emit(100); f.emit(100);
  assert.equal(f.head.jumpWaitMs, 40);
  f.head.setAlignment({ networkCompensationMs: 200 });
  f.emit(200); f.emit(200); f.emit(200);
  const jump = f.plan(200);
  assert.equal(jump.waiting, false);
  assert.equal(f.head.drainEvents().filter(e => e.kind === 'jump').length, 0);
  f.head.emittedFrame(jump, 120, true);
  const events = f.head.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === 'jump' && events[0].waitedMs, 60);
});

test('fallback withdrawal retires a waiting jump without suppressing an independent calibration request', () => {
  const f = fixture(); f.emit(0);
  f.head.setAlignment({ networkCompensationMs: 100 }); f.emit(100);
  f.head.freezeFallbackAtHeard();
  f.emit(0);
  assert.equal(f.head.alignment.networkCompensationMs, 0);
  assert.equal(f.head.jumpWaitMs, 0);
  f.head.setAlignment({ calibratedMicLagMs: 200 });
  f.head.acceptCalibration({ kind: 'content', revision: 1 });
  f.head.freezeFallbackAtHeard(); f.emit(200);
  assert.equal(f.head.status.phase, 'waiting-for-quiet');
  assert.equal(f.head.status.acceptedCalibration?.revision, 1);
  f.emit(200, false, true, false);
  assert.equal(f.head.heardMicAdvanceMs, 200, 'frontier safety bypasses the wait');
});

test('withdrawing fallback before the first frame restores the epoch baseline', () => {
  const f = fixture();
  f.head.setAlignment({ networkCompensationMs: 200 });
  f.head.freezeFallbackAtHeard();
  assert.equal(f.head.alignment.networkCompensationMs, 0);
  f.head.setAlignment({ networkCompensationMs: 100 });
  f.head.resetContinuity();
  f.head.setAlignment({ networkCompensationMs: 200 });
  f.head.freezeFallbackAtHeard();
  assert.equal(f.head.alignment.networkCompensationMs, 100, 'a new epoch retains its own neutral alignment');
});

test('nearby target updates cannot postpone a held-note jump indefinitely', () => {
  const f = fixture(); f.emit(0);
  f.head.setAlignment({ networkCompensationMs: 100 }); f.emit(100);
  for (const target of [101, 99, 102]) {
    f.head.walkFallbackTo(target, true);
    f.head.advanceWalks();
    f.emit(f.head.alignment.networkCompensationMs);
  }
  assert.ok(f.head.heardMicAdvanceMs! > 90);
  const jump = f.head.drainEvents().find(event => event.kind === 'jump');
  assert.equal(jump?.kind === 'jump' && jump.waitedMs, 60);
});

test('a walk must reach its target with complete audio before acknowledging authority', () => {
  const f = fixture(); f.head.setAlignment({ calibratedMicLagMs: 100 }); f.emit(100);
  f.head.walkCalibrationTo(100.08, true);
  f.head.acceptCalibration({ kind: 'content', revision: 2 });
  f.head.advanceWalks(); f.emit(f.head.alignment.calibratedMicLagMs!);
  assert.equal(f.head.status.phase, 'walking');
  assert.notEqual(f.head.status.settled?.authority?.revision, 2);
  f.head.advanceWalks(); f.emit(f.head.alignment.calibratedMicLagMs!, false, false);
  assert.equal(f.head.status.phase, 'pending');
  f.emit(100.08);
  assert.equal(f.head.status.phase, 'settled');
  assert.equal(f.head.status.settled?.authority?.revision, 2);
});

test('epoch retirement fences a previously planned frame and owner reset cannot restore old fallback', () => {
  const f = fixture(); f.head.setAlignment({ networkCompensationMs: 100 }); f.emit(100);
  const stale = f.plan(100);
  f.head.resetContinuity();
  f.head.emittedFrame(stale, 0, true);
  assert.equal(f.head.heardMicAdvanceMs, null);
  assert.equal(f.head.status.settled, null);
  f.head.resetFallbackForOwner();
  f.head.setAlignment({ networkCompensationMs: 200 });
  f.head.freezeFallbackAtHeard();
  assert.equal(f.head.alignment.networkCompensationMs, 0);
});

test('inactive fallback updates cannot restart a calibration wait or block its emitted acknowledgement', () => {
  const f = fixture(); f.head.setAlignment({ calibratedMicLagMs: 100 }); f.emit(100);
  f.head.setAlignment({ calibratedMicLagMs: 200 });
  f.head.acceptCalibration({ kind: 'content', revision: 2 });
  for (let index = 0; index < 3; index++) {
    f.head.walkFallbackTo(10 + index, true);
    f.emit(200);
  }
  assert.equal(f.head.jumpWaitMs, 60);
  f.head.walkFallbackTo(14, true);
  f.emit(200);
  assert.equal(f.head.heardMicAdvanceMs, 200);
  assert.equal(f.head.status.phase, 'settled');
  assert.equal(f.head.status.settled?.authority?.revision, 2);
});
