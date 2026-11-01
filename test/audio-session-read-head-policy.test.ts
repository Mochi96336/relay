import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AudioSession, MIC_WALK_LIMIT_MS } from '../src/audio-session.js';

const RATE = 48_000;
const FRAME_MS = 20;
const PREBUFFER_MS = 600;
const TONE_HZ = 500;
const TONE_AMPLITUDE = 8_000;
const PERIOD_SAMPLES = RATE / TONE_HZ;

/** A 500 Hz tone, silent over `silence` (seconds on the Mic's own timeline). */
function voice(seconds: number, silence: [number, number] | null = null) {
  const pcm = Buffer.alloc(seconds * RATE * 2);
  for (let index = 0; index < seconds * RATE; index += 1) {
    const at = index / RATE;
    const quiet = silence !== null && at >= silence[0] && at < silence[1];
    const value = quiet ? 0 : Math.round(TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / RATE));
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

function makeSession(pcm: Buffer) {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: PREBUFFER_MS,
    backingGain: 0.65,
    retentionMs: 3_000,
    backingRetentionMs: 1_000,
  });
  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.start(0);
  session.setAlignment({ calibratedMicLagMs: 100 });
  session.ingestMic({ generation: 1, firstSampleIndex: 0, pcm }, RATE, 0);
  return session;
}

const framesRun = new WeakMap<AudioSession, number>();

/** Mixes the next `frames` frames, carrying on from where the last call stopped. */
function run(session: AudioSession, frames: number, onFrame: (frame: number) => void = () => {}) {
  const samples: number[] = [];
  const first = framesRun.get(session) ?? 0;
  for (let frame = first; frame < first + frames; frame += 1) {
    onFrame(frame);
    session.drain((pcm) => {
      for (let index = 0; index < pcm.byteLength / 2; index += 1) samples.push(pcm.readInt16LE(index * 2));
    }, PREBUFFER_MS + frame * FRAME_MS, 1);
  }
  framesRun.set(session, first + frames);
  return samples;
}

/** The quietest tone period in [from, to), against the loudest one. */
function quietestPeriod(samples: number[], from: number, to: number) {
  let loudest = 0;
  let quietest = Infinity;
  for (let start = from; start + PERIOD_SAMPLES <= to; start += PERIOD_SAMPLES) {
    let peak = 0;
    for (let index = start; index < start + PERIOD_SAMPLES; index += 1) peak = Math.max(peak, Math.abs(samples[index]!));
    loudest = Math.max(loudest, peak);
    quietest = Math.min(quietest, peak);
  }
  return { loudest, quietest };
}

test('a jump over a held note waits for the singer to pause, and the note never dips', () => {
  // The Mic is silent from 3.8 s to 4.3 s on its own timeline; read 100 ms
  // ahead, the read head reaches that pause at about 3.7 s of output.
  const session = makeSession(voice(8, [3.8, 4.3]));
  const samples = run(session, 300, (frame) => {
    if (frame === 100) session.setAlignment({ calibratedMicLagMs: 130 });
  });
  const events = session.drainMicReadHeadEvents();
  const jumps = events.filter((event) => event.kind === 'jump');
  assert.equal(jumps.length, 1, JSON.stringify(events));
  const jump = jumps[0]!;
  assert.equal(jump.kind === 'jump' && jump.quiet, true, JSON.stringify(jump));
  assert.ok(jump.kind === 'jump' && jump.waitedMs > 1_000 && jump.waitedMs < 3_000, JSON.stringify(jump));
  assert.ok(jump.kind === 'jump' && Math.abs((jump.moved.calibratedMicLagMs ?? 0) - 30) < 1e-9, JSON.stringify(jump));
  // While it waited the voice stayed where it was heard; nothing dipped.
  const { loudest, quietest } = quietestPeriod(samples, RATE, Math.round(3.6 * RATE));
  assert.ok(quietest > loudest * 0.9, `the held note dipped to ${quietest} of ${loudest}`);
  assert.equal(session.micReadHeadJumpWaitMs, 0);
});

test('a jump that finds no pause goes anyway once the wait runs out, and says so', () => {
  const session = makeSession(voice(10));
  run(session, 260, (frame) => {
    if (frame === 60) session.setAlignment({ calibratedMicLagMs: 130 });
  });
  const jumps = session.drainMicReadHeadEvents().filter((event) => event.kind === 'jump');
  assert.equal(jumps.length, 1, JSON.stringify(jumps));
  assert.deepEqual(
    jumps[0]!.kind === 'jump' && [jumps[0]!.quiet, jumps[0]!.waitedMs],
    [false, 3_000],
  );
});

test('a small live correction walks at 0.2% of a frame per frame', () => {
  const session = makeSession(voice(4));
  run(session, 10);
  assert.equal(session.slewCalibratedMicLagTo(110), true);
  run(session, 1);
  const walked = session.alignment.calibratedMicLagMs! - 100;
  assert.ok(Math.abs(walked - FRAME_MS * 0.002) < 1e-9, `walked ${walked} ms in one frame`);
  const events = session.drainMicReadHeadEvents();
  assert.deepEqual(events.map((event) => event.kind), ['walk-start']);
});

test('a live correction too far to walk is taken at once and jumped to', () => {
  const session = makeSession(voice(4));
  run(session, 10);
  session.slewCalibratedMicLagTo(100 + MIC_WALK_LIMIT_MS + 5);
  assert.equal(session.alignment.calibratedMicLagMs, 100 + MIC_WALK_LIMIT_MS + 5);
});

test('while a jump waits, the heard advance stays put and the applied one has moved', () => {
  const session = makeSession(voice(8));
  run(session, 60);
  const before = session.heardMicAdvanceMs!;
  session.setAlignment({ calibratedMicLagMs: 130 });
  run(session, 5);
  assert.ok(session.micReadHeadJumpWaitMs > 0);
  assert.ok(Math.abs(session.heardMicAdvanceMs! - before) < 1e-9, `heard ${session.heardMicAdvanceMs}`);
  assert.ok(Math.abs(session.appliedMicAdvanceMs - (before + 30)) < 1e-9, `applied ${session.appliedMicAdvanceMs}`);
});

test('a Take start lands a waiting jump on the next frame and stops a walk where it is', () => {
  const session = makeSession(voice(8));
  run(session, 60);
  session.setAlignment({ calibratedMicLagMs: 130 });
  run(session, 5);
  assert.ok(session.micReadHeadJumpWaitMs > 0);
  session.settleMicReadHead();
  run(session, 1);
  assert.equal(session.micReadHeadJumpWaitMs, 0);
  assert.ok(Math.abs(session.heardMicAdvanceMs! - session.appliedMicAdvanceMs) < 1e-9);
  const jump = session.drainMicReadHeadEvents().find((event) => event.kind === 'jump');
  assert.equal(jump?.kind === 'jump' && jump.quiet, false);

  session.slewCalibratedMicLagTo(140);
  run(session, 3);
  const walked = session.alignment.calibratedMicLagMs!;
  assert.ok(walked > 130 && walked < 131);
  session.settleMicReadHead();
  run(session, 10);
  assert.equal(session.alignment.calibratedMicLagMs, walked);
});
