import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';

const RATE = 48_000;
const PACKET = 480;
const NETWORK_MS = 70;
const NETWORK_COMPENSATION_MS = 137;

function packet(generation: number, firstSampleIndex: number) {
  const pcm = Buffer.alloc(PACKET * 2);
  for (let i = 0; i < PACKET; i += 1) {
    const n = firstSampleIndex + i;
    pcm.writeInt16LE(Math.round(3_000 * Math.sin((2 * Math.PI * 220 * n) / RATE)), i * 2);
  }
  return { generation, firstSampleIndex, pcm };
}

type Outage = {
  /** When the server lost the phone's socket. */
  closeAtMs: number;
  /** When the reconnected phone registered again. */
  registeredAtMs: number;
  /** When its first packet after the outage arrived. */
  resumedAtMs: number;
  /** The capture that resumes: the same one, or a new generation. */
  resumedGeneration: number;
};

/**
 * A WebSocket-only phone (no WebTransport, so every iPhone) singing into a
 * Mic-only room. Its socket drops; the server stops expecting the Mic until
 * the phone registers again, and the phone keeps capturing, so the first
 * packet afterwards states its real, later position.
 */
function simulate(outage: Outage, untilMs = 30_000) {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.setMicExpected(true);
  session.setAlignment({ networkCompensationMs: NETWORK_COMPENSATION_MS });

  const frames: Array<{ atMs: number; peak: number; correctionMs: number; appliedMs: number }> = [];
  let capturedUntilMs = 0;
  let generationStartMs = 0;
  let generation = 4_100;
  for (let nowMs = 0; nowMs <= untilMs; nowMs += 5) {
    if (nowMs === outage.closeAtMs) session.setMicExpected(false);
    if (nowMs === outage.registeredAtMs) session.setMicExpected(true);
    while (capturedUntilMs + 10 + NETWORK_MS <= nowMs) {
      capturedUntilMs += 10;
      const arrivesAtMs = capturedUntilMs + NETWORK_MS;
      // Sent while the socket was down: dropped on the phone, never resent.
      if (arrivesAtMs >= outage.closeAtMs && arrivesAtMs < outage.resumedAtMs) continue;
      if (arrivesAtMs >= outage.resumedAtMs && generation !== outage.resumedGeneration) {
        generation = outage.resumedGeneration;
        generationStartMs = capturedUntilMs - 10;
      }
      const first = ((capturedUntilMs - 10 - generationStartMs) * RATE) / 1000;
      session.ingestMic(packet(generation, first), RATE, nowMs);
    }
    session.drain((frame) => {
      let peak = 0;
      for (let offset = 0; offset < frame.length; offset += 2) {
        peak = Math.max(peak, Math.abs(frame.readInt16LE(offset)));
      }
      frames.push({
        atMs: nowMs,
        peak,
        correctionMs: session.micFrontierCorrectionMs,
        appliedMs: session.appliedMicAdvanceMs,
      });
    }, nowMs);
  }
  return frames;
}

const OUTAGE = { closeAtMs: 10_000, registeredAtMs: 11_500, resumedAtMs: 11_650 };

test('a phone that reconnects on the same capture is heard on time, not seconds late', () => {
  const frames = simulate({ ...OUTAGE, resumedGeneration: 4_100 });

  // Before this, the frames between registration and the first packet saw a
  // frontier frozen for 1.5 s, took it for lateness rather than an outage,
  // and pulled the read head back into the audio from before the drop: the
  // voice then ran 1.3 s late and caught up at 10 ms a second.
  for (const frame of frames.filter((candidate) => candidate.atMs >= OUTAGE.registeredAtMs)) {
    assert.equal(frame.correctionMs, 0, `no frontier correction at ${frame.atMs} ms`);
    assert.equal(frame.appliedMs, NETWORK_COMPENSATION_MS, `on-time alignment at ${frame.atMs} ms`);
  }
  const heardAgain = frames.find((frame) => frame.atMs > OUTAGE.resumedAtMs && frame.peak > 0);
  assert.ok(heardAgain, 'the resumed capture is heard');
  assert.ok(
    heardAgain.atMs <= OUTAGE.resumedAtMs + 400,
    `heard again within the prebuffer of its first packet, not later (${heardAgain.atMs} ms)`,
  );
});

test('the audio from before an outage is not replayed while the phone reconnects', () => {
  for (const resumedGeneration of [4_100, 4_200]) {
    const frames = simulate({ ...OUTAGE, resumedGeneration }, 14_000);
    // The last audio before the drop has played out by the time the phone
    // registers again; anything audible before its next packet is a replay.
    const replayed = frames.filter((frame) => (
      frame.atMs >= OUTAGE.registeredAtMs && frame.atMs < OUTAGE.resumedAtMs && frame.peak > 0
    ));
    assert.deepEqual(replayed.map((frame) => frame.atMs), [], `generation ${resumedGeneration}`);
  }
});

test('a phone whose packets merely stall is still not chased, with or without expectation', () => {
  // The control plane can drop while WebTransport media stays up, so the
  // server keeps expecting the Mic. The frontier freezes the same way and
  // must be read the same way: an outage, not lateness.
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.setMicExpected(true);
  session.setAlignment({ networkCompensationMs: NETWORK_COMPENSATION_MS });
  let capturedUntilMs = 0;
  let maxCorrectionMs = 0;
  for (let nowMs = 0; nowMs <= 20_000; nowMs += 5) {
    while (capturedUntilMs + 10 + NETWORK_MS <= nowMs) {
      capturedUntilMs += 10;
      const arrivesAtMs = capturedUntilMs + NETWORK_MS;
      if (arrivesAtMs >= OUTAGE.closeAtMs && arrivesAtMs < OUTAGE.resumedAtMs) continue;
      session.ingestMic(packet(4_300, ((capturedUntilMs - 10) * RATE) / 1000), RATE, nowMs);
    }
    session.drain(() => {}, nowMs);
    maxCorrectionMs = Math.max(maxCorrectionMs, session.micFrontierCorrectionMs);
  }
  assert.equal(maxCorrectionMs, 0);
});
