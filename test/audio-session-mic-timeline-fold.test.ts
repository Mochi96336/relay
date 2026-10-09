import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession, type MixFrameEvidence } from '../src/audio-session.js';
import { MicCaptureDeliveryMonitor } from '../src/mic-capture-delivery.js';

const RATE = 48_000;
const CHUNK = 480; // the phone's 10 ms packets
const NETWORK_MS = 70;
const GENERATION = 11_598_927;

function chunk(firstSampleIndex: number, generation = GENERATION) {
  const pcm = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < CHUNK; i += 1) {
    const n = firstSampleIndex + i;
    // Two partials, so a read landing anywhere but the right sample shows.
    const value = 5_000 * Math.sin((2 * Math.PI * 220 * n) / RATE)
      + 2_000 * Math.sin((2 * Math.PI * 331 * n) / RATE);
    pcm.writeInt16LE(Math.round(value), i * 2);
  }
  return { generation, firstSampleIndex, pcm };
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

type Phone = {
  /** Every `lossEveryMs` the capture loses `lossMs` of real time: no samples, numbering contiguous. */
  lossEveryMs: number;
  lossMs: number;
  /** Every `dropEveryMs`, `dropPackets` packets are lost in transport: a real hole. */
  dropEveryMs?: number;
  dropPackets?: number;
  /** Transport delay that keeps growing, as a queue would. */
  queueGrowthMsPerSecond?: number;
};

type Frame = { pcm: Buffer; evidence: MixFrameEvidence; playable: boolean; headroomMs: number | null };

function makeSession(retentionMs: number) {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs,
  });
  session.start(0);
  session.setMicExpected(true);
  session.setAlignment({ networkCompensationMs: 137 });
  return session;
}

/**
 * Runs a phone against `session` for `seconds`, reporting uplink health once a
 * second through `onHealth` the way the server does.
 */
function simulate(
  session: AudioSession,
  phone: Phone,
  seconds: number,
  onHealth?: (atMs: number, capturedSamples: number) => void,
) {
  const frames: Frame[] = [];
  const healthJitter = random(11);
  let cursor = 0;
  let capturedUntilMs = 0;
  let nextLossAtMs = phone.lossEveryMs;
  let nextDropAtMs = phone.dropEveryMs ?? Number.POSITIVE_INFINITY;
  let dropRemaining = 0;
  let lastArrivalMs = 0;
  let nextHealthAtMs = 1_000;
  const inFlight: Array<{ atMs: number; first: number }> = [];

  for (let nowMs = 0; nowMs <= seconds * 1_000; nowMs += 5) {
    while (capturedUntilMs + 10 <= nowMs) {
      capturedUntilMs += 10;
      if (capturedUntilMs >= nextLossAtMs) {
        capturedUntilMs += phone.lossMs;
        nextLossAtMs += phone.lossEveryMs;
      }
      if (capturedUntilMs >= nextDropAtMs) {
        dropRemaining = phone.dropPackets ?? 0;
        nextDropAtMs += phone.dropEveryMs!;
      }
      const queueMs = ((phone.queueGrowthMsPerSecond ?? 0) * capturedUntilMs) / 1_000;
      const atMs = Math.max(lastArrivalMs, capturedUntilMs + NETWORK_MS + queueMs);
      if (dropRemaining > 0) {
        dropRemaining -= 1;
      } else {
        inFlight.push({ atMs, first: cursor });
        lastArrivalMs = atMs;
      }
      cursor += CHUNK;
    }
    while (inFlight.length > 0 && inFlight[0]!.atMs <= nowMs) {
      session.ingestMic(chunk(inFlight.shift()!.first), RATE, nowMs);
    }
    if (onHealth && nowMs >= nextHealthAtMs) {
      onHealth(nowMs + healthJitter() * 50, cursor);
      nextHealthAtMs += 1_000;
    }
    session.drain((pcm, evidence) => {
      frames.push({
        pcm: Buffer.from(pcm),
        evidence: { ...evidence },
        playable: session.micPlayable,
        headroomMs: session.liveMicHeadroomMs,
      });
    }, nowMs);
  }
  return frames;
}

/** Feeds the phone's health through the same monitor the server uses. */
function confirmLoss(session: AudioSession) {
  const monitor = new MicCaptureDeliveryMonitor();
  return (atMs: number, capturedSamples: number) => {
    monitor.observe({ generation: GENERATION, capturedSamples, sampleRate: RATE, atMs });
    const status = monitor.status();
    if (status) session.noteMicCaptureLoss(status.generation, status.lossMs);
  };
}

// What 2026-10-03 looked like: about 220 ms of capture lost every 7 s.
const SLIPPING_PHONE: Phone = { lossEveryMs: 7_000, lossMs: 220 };

test('without confirmation, a capture that keeps losing time still pins the correction and goes silent', () => {
  // The bug as it was: nothing tells the mixer the time was never captured.
  const session = makeSession(3_000);
  const frames = simulate(session, SLIPPING_PHONE, 240);
  assert.equal(session.micTimelineFoldCount, 0);
  assert.equal(Math.round(session.appliedMicAdvanceMs), -2800);
  assert.equal(frames.at(-1)!.playable, false);
  assert.ok(frames.at(-1)!.headroomMs! < -3_000, `ended at ${frames.at(-1)!.headroomMs} ms`);
});

test('confirmed capture loss is folded into the timeline and the Mic stays audible', () => {
  const session = makeSession(3_000);
  const frames = simulate(session, SLIPPING_PHONE, 240, confirmLoss(session));

  // 240 s at ~3% is more than seven seconds of slip; the bound is under three.
  assert.ok(session.micTimelineFoldCount >= 2, `folded ${session.micTimelineFoldCount} times`);
  // Each burst of lost capture is still a moment with nothing to play, as it
  // was below the bound; what must not happen is the read head staying past
  // the frontier once the bound is reached.
  const settled = frames.slice(Math.ceil(10_000 / 20));
  let longestRun = 0;
  let run = 0;
  for (const frame of settled) {
    run = frame.playable ? 0 : run + 1;
    longestRun = Math.max(longestRun, run);
  }
  assert.ok(longestRun <= 10, `the Mic was unplayable for ${longestRun} frames in a row`);
  assert.ok(frames.at(-1)!.headroomMs! > 0, `ended at ${frames.at(-1)!.headroomMs} ms of headroom`);
  assert.ok(session.micFrontierCorrectionMs < 2_937, `correction ${session.micFrontierCorrectionMs} ms`);

  const fold = session.lastMicTimelineFold;
  assert.ok(fold);
  assert.ok(fold.shiftMs > 1_000 && fold.shiftMs <= fold.correctionBeforeMs, JSON.stringify(fold));
});

test('a fold is inaudible: output matches a mixer whose history never ran out', () => {
  // Same phone, real packet holes included. One mixer folds; the other has
  // enough retention never to need to, so it keeps the whole slip as
  // correction. Every emitted sample and every piece of evidence must agree.
  const phone: Phone = { ...SLIPPING_PHONE, dropEveryMs: 23_000, dropPackets: 3 };
  const folding = makeSession(3_000);
  const unbounded = makeSession(60_000);
  const foldingFrames = simulate(folding, phone, 240, confirmLoss(folding));
  const unboundedFrames = simulate(unbounded, phone, 240);

  assert.ok(folding.micTimelineFoldCount >= 2, `folded ${folding.micTimelineFoldCount} times`);
  assert.equal(unbounded.micTimelineFoldCount, 0);
  assert.ok(
    unbounded.micFrontierCorrectionMs > 2_937,
    `the reference must have needed more than the bound, held ${unbounded.micFrontierCorrectionMs} ms`,
  );
  assert.equal(foldingFrames.length, unboundedFrames.length);
  for (let index = 0; index < foldingFrames.length; index += 1) {
    const a = foldingFrames[index]!;
    const b = unboundedFrames[index]!;
    if (!a.pcm.equals(b.pcm)) assert.fail(`frame ${index} (${(index * 20) / 1000} s) differs`);
    assert.deepEqual(a.evidence, b.evidence, `evidence of frame ${index}`);
    assert.equal(a.playable, b.playable, `playability of frame ${index}`);
    assert.equal(a.headroomMs, b.headroomMs, `headroom of frame ${index}`);
  }
});

test('lateness the phone does not confirm stays a bounded correction', () => {
  // A queue that keeps growing: the phone captures in real time, so its health
  // shows no loss, and the lateness must stay recoverable rather than folded.
  const session = makeSession(3_000);
  const phone: Phone = { lossEveryMs: Number.POSITIVE_INFINITY, lossMs: 0, queueGrowthMsPerSecond: 30 };
  simulate(session, phone, 150, confirmLoss(session));
  assert.equal(session.micTimelineFoldCount, 0);
  assert.equal(Math.round(session.appliedMicAdvanceMs), -2800);
});

test('loss confirmed for another capture is not folded into this one', () => {
  const session = makeSession(3_000);
  const monitor = new MicCaptureDeliveryMonitor();
  simulate(session, SLIPPING_PHONE, 150, (atMs, capturedSamples) => {
    monitor.observe({ generation: GENERATION + 1, capturedSamples, sampleRate: RATE, atMs });
    session.noteMicCaptureLoss(GENERATION + 1, monitor.status()!.lossMs);
  });
  assert.equal(session.micTimelineFoldCount, 0);
});

/**
 * A phone on the WebSocket media path: its packets and its uplink health
 * reports leave through one ordered socket, so a congested uplink delays both.
 * The phone captures in real time throughout. `serviceMs(startsAtMs)` is how
 * long the link takes to carry one 10 ms packet that starts crossing then.
 */
function simulateSharedQueue(
  session: AudioSession,
  seconds: number,
  serviceMs: (startsAtMs: number) => number,
  afterTick?: (nowMs: number) => void,
) {
  const frames: Frame[] = [];
  const monitor = new MicCaptureDeliveryMonitor();
  type Sent = { atMs: number; kind: 'audio'; first: number } | { atMs: number; kind: 'health'; captured: number };
  const inFlight: Sent[] = [];
  let cursor = 0;
  let capturedUntilMs = 0;
  let linkFreeAt = 0;
  let nextHealthAtMs = 1_000;

  for (let nowMs = 0; nowMs <= seconds * 1_000; nowMs += 5) {
    while (capturedUntilMs + 10 <= nowMs) {
      capturedUntilMs += 10;
      const startsAt = Math.max(linkFreeAt, capturedUntilMs);
      linkFreeAt = startsAt + serviceMs(startsAt);
      inFlight.push({ atMs: linkFreeAt + NETWORK_MS, kind: 'audio', first: cursor });
      cursor += CHUNK;
      if (capturedUntilMs >= nextHealthAtMs) {
        // A few hundred bytes behind the queued audio, in the same socket.
        inFlight.push({ atMs: linkFreeAt + NETWORK_MS, kind: 'health', captured: cursor });
        nextHealthAtMs += 1_000;
      }
    }
    while (inFlight.length > 0 && inFlight[0]!.atMs <= nowMs) {
      const sent = inFlight.shift()!;
      if (sent.kind === 'audio') {
        session.ingestMic(chunk(sent.first), RATE, nowMs);
      } else {
        monitor.observe({ generation: GENERATION, capturedSamples: sent.captured, sampleRate: RATE, atMs: nowMs });
        const status = monitor.status();
        if (status) session.noteMicCaptureLoss(status.generation, status.lossMs);
      }
    }
    session.drain((pcm, evidence) => {
      frames.push({
        pcm: Buffer.from(pcm),
        evidence: { ...evidence },
        playable: session.micPlayable,
        headroomMs: session.liveMicHeadroomMs,
      });
    }, nowMs);
    afterTick?.(nowMs);
  }
  return frames;
}

test('a queue that delayed the health reports with the audio is not left folded into the timeline', () => {
  // As on 2026-10-09 at 21:05, longer: from 20 s to 40 s the uplink carries
  // 85% of real time, so audio and its health reports queue together and fall
  // 3.5 s behind; afterwards it drains at more than three times real time. The
  // phone never lost any capture, so once the queue has drained the voice must
  // be read exactly where a mixer that never folded reads it.
  const congested = (startsAtMs: number) => (startsAtMs > 20_000 && startsAtMs <= 40_000 ? 11.8 : 3);
  const folding = makeSession(3_000);
  const unbounded = makeSession(60_000);
  const foldingFrames = simulateSharedQueue(folding, 90, congested);
  const unboundedFrames = simulateSharedQueue(unbounded, 90, congested);

  assert.ok(folding.micTimelineFoldCount >= 1, 'the delayed reports read as capture loss and were folded');
  assert.equal(unbounded.micTimelineFoldCount, 0);
  assert.ok(folding.micTimelineUnfoldCount >= 1, 'the fold is undone once the reports are on time again');

  const settledFrom = Math.ceil(60_000 / 20);
  for (let index = settledFrom; index < foldingFrames.length; index += 1) {
    const a = foldingFrames[index]!;
    const b = unboundedFrames[index]!;
    if (!a.pcm.equals(b.pcm)) {
      assert.fail(`frame ${index} (${(index * 20) / 1000} s) differs: headroom ${a.headroomMs} vs ${b.headroomMs} ms`);
    }
    assert.equal(a.headroomMs, b.headroomMs, `headroom of frame ${index}`);
  }
  assert.equal(Math.round(folding.appliedMicAdvanceMs), 137);
});

test('a calibration measured across a mistaken fold gives the fold up when it is undone', () => {
  // The same queue, but a calibration completes while the delayed reports are
  // still folded into the timeline. It measures the voice where the fold put
  // it; once the fold is undone, the voice must still be read exactly where a
  // mixer that never folded, calibrated without the fold, reads it.
  const congested = (startsAtMs: number) => (startsAtMs > 20_000 && startsAtMs <= 40_000 ? 11.8 : 3);
  const run = (noteMeasured: boolean) => {
    const session = makeSession(3_000);
    let measured = false;
    const frames = simulateSharedQueue(session, 90, congested, () => {
      if (measured || session.micTimelineFoldCount === 0) return;
      measured = true;
      session.setAlignment({ calibratedMicLagMs: 137 + session.micTimelineFoldedMs });
      if (noteMeasured) session.noteMicCalibrationMeasured();
    });
    assert.ok(measured, 'the delayed reports were folded');
    assert.ok(session.micTimelineUnfoldCount >= 1, 'and the loss fell again');
    return { session, frames };
  };
  const unbounded = makeSession(60_000);
  unbounded.setAlignment({ calibratedMicLagMs: 137 });
  const reference = simulateSharedQueue(unbounded, 90, congested);
  assert.equal(unbounded.micTimelineFoldCount, 0);

  const noted = run(true);
  assert.equal(
    noted.session.lastMicTimelineUnfold!.calibrationMs,
    noted.session.lastMicTimelineUnfold!.shiftMs,
    JSON.stringify(noted.session.lastMicTimelineUnfold),
  );
  const settledFrom = Math.ceil(60_000 / 20);
  for (let index = settledFrom; index < reference.length; index += 1) {
    const a = noted.frames[index]!;
    const b = reference[index]!;
    if (!a.pcm.equals(b.pcm)) {
      assert.fail(`frame ${index} (${(index * 20) / 1000} s) differs: headroom ${a.headroomMs} vs ${b.headroomMs} ms`);
    }
    assert.equal(a.headroomMs, b.headroomMs, `headroom of frame ${index}`);
  }
  assert.equal(Math.round(noted.session.appliedMicAdvanceMs), 137);

  // Without the note, as before: the voice is no longer where the reference reads it.
  const unnoted = run(false);
  assert.equal(unnoted.session.lastMicTimelineUnfold!.calibrationMs, 0);
  const settled = unnoted.frames.slice(settledFrom);
  assert.ok(
    settled.some((frame, offset) => !frame.pcm.equals(reference[settledFrom + offset]!.pcm)),
    'the gap this closes must show without it',
  );
});
