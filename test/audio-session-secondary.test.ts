import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AudioSession, type MixFrameEvidence } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;

function makeSession() {
  const session = new AudioSession({
    sampleRate: RATE, frameMs: 20, prebufferMs: 600, backingGain: 1, retentionMs: 5_000,
  });
  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.setBackingExpected(true);
  return session;
}

function frame(pcm: Buffer, generation = 1): PcmFrame {
  return { generation, firstSampleIndex: 0, pcm };
}

function silence(ms: number) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

/** `totalMs` of silence with `level` held for one millisecond at `markMs`. */
function markedAt(totalMs: number, markMs: number, level: number) {
  const pcm = silence(totalMs);
  const start = Math.round((RATE * markMs) / 1000);
  for (let i = 0; i < RATE / 1000; i += 1) pcm.writeInt16LE(level, (start + i) * 2);
  return pcm;
}

/** A square wave at `level`, the worst case for summing two voices. */
function square(ms: number, level: number, periodSamples: number) {
  const pcm = silence(ms);
  for (let i = 0; i < pcm.length / 2; i += 1) {
    pcm.writeInt16LE(Math.floor(i / (periodSamples / 2)) % 2 === 0 ? level : -level, i * 2);
  }
  return pcm;
}

function drainAll(session: AudioSession, untilMs: number) {
  const frames: Buffer[] = [];
  const evidence: MixFrameEvidence[] = [];
  while (session.drain((f, e) => { frames.push(f); evidence.push(e); }, untilMs) > 0) { /* keep pulling */ }
  return { mixed: Buffer.concat(frames), evidence };
}

function peakAt(mixed: Buffer, fromMs: number, toMs: number) {
  let index = -1;
  let value = 0;
  for (let i = Math.round((fromMs * RATE) / 1000); i < Math.min(mixed.length / 2, Math.round((toMs * RATE) / 1000)); i += 1) {
    const v = Math.abs(mixed.readInt16LE(i * 2));
    if (v > value) { value = v; index = i; }
  }
  return { ms: (index / RATE) * 1000, value };
}

describe('AudioSession second singer', () => {
  test('a B with no lag yet leaves the room mix byte-identical to N=1', () => {
    const run = (withB: boolean) => {
      const session = makeSession();
      session.start(0);
      session.ingestBacking(frame(markedAt(1_500, 400, 9_000)), RATE, 0);
      session.ingestMic(frame(markedAt(1_500, 700, 9_000)), RATE, 0);
      session.setAlignment({ calibratedMicLagMs: 300 });
      if (withB) {
        session.attachSecondaryMic();
        session.setSecondaryMicGainDb(0);
        session.ingestSecondaryMic(frame(markedAt(1_500, 900, 20_000)), RATE, 0);
      }
      return drainAll(session, 1_400).mixed;
    };
    assert.ok(run(false).equals(run(true)));
  });

  test("B's own lag places its voice on the song's beat next to A", () => {
    // Song event at 400 ms. A sings it 300 ms late, B 250 ms late.
    const run = (aLevel: number, bLevel: number) => {
      const session = makeSession();
      session.start(0);
      session.ingestBacking(frame(silence(2_000)), RATE, 0);
      session.ingestMic(frame(markedAt(2_000, 700, aLevel)), RATE, 0);
      session.setAlignment({ calibratedMicLagMs: 300 });
      session.attachSecondaryMic();
      session.setSecondaryMicGainDb(0);
      session.ingestSecondaryMic(frame(markedAt(2_000, 650, bLevel)), RATE, 0);
      session.setSecondaryMicLag(250);
      const peak = peakAt(drainAll(session, 1_200 + 600).mixed, 0, 1_200);
      assert.equal(session.secondaryMic?.blend, 1);
      return peak;
    };
    for (const [a, b] of [[12_000, 0], [0, 12_000], [12_000, 12_000]]) {
      const peak = run(a, b);
      assert.ok(Math.abs(peak.ms - 400) < 2, `A=${a} B=${b}: on the beat at ~400 ms, peak at ${peak.ms.toFixed(1)} ms`);
    }
    // Two singers sum as two voices in one room would, keeping their balance.
    const aAlone = run(12_000, 0).value;
    const bAlone = run(0, 6_000).value;
    const both = run(12_000, 6_000).value;
    assert.ok(Math.abs(both - (aAlone + bAlone)) / (aAlone + bAlone) < 0.03,
      `both ${both} vs A ${aAlone} + B ${bAlone}`);
  });

  test('a sum past the ceiling is turned down, and comes back up for a voice alone', () => {
    const session = makeSession();
    session.start(0);
    session.ingestBacking(frame(silence(3_000)), RATE, 0);
    // Both near full scale for one second, then A alone.
    session.ingestMic(frame(square(3_000, 30_000, 96)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 0 });
    session.attachSecondaryMic();
    session.setSecondaryMicGainDb(0);
    session.ingestSecondaryMic(frame(Buffer.concat([square(1_000, 30_000, 96), silence(2_000)])), RATE, 0);
    session.setSecondaryMicLag(0);
    const { mixed, evidence } = drainAll(session, 600 + 2_400);
    assert.equal(evidence.reduce((sum, e) => sum + e.clippedSamples, 0), 0);
    const together = peakAt(mixed, 300, 900).value;
    const aloneAfter = peakAt(mixed, 1_600, 2_300).value;
    assert.ok(Math.abs(together - aloneAfter) / aloneAfter < 0.05,
      `two full voices are held at one voice's ceiling (${together} vs ${aloneAfter})`);
  });

  test('two full-scale voices and the song never clip the room mix', () => {
    const session = makeSession();
    session.start(0);
    session.ingestBacking(frame(square(2_000, 30_000, 96)), RATE, 0);
    session.ingestMic(frame(square(2_000, 32_000, 96)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 0 });
    session.attachSecondaryMic();
    session.setSecondaryMicGainDb(0);
    session.ingestSecondaryMic(frame(square(2_000, 32_000, 96)), RATE, 0);
    session.setSecondaryMicLag(0);

    const { evidence } = drainAll(session, 1_800);
    const clipped = evidence.reduce((sum, e) => sum + e.clippedSamples, 0);
    assert.equal(clipped, 0);
  });

  test('A singing alone stays at full level while a silent B is connected', () => {
    const level = (withB: boolean) => {
      const session = makeSession();
      session.start(0);
      session.ingestBacking(frame(silence(2_000)), RATE, 0);
      session.ingestMic(frame(square(2_000, 12_000, 96)), RATE, 0);
      session.setAlignment({ calibratedMicLagMs: 0 });
      if (withB) {
        session.attachSecondaryMic();
        session.setSecondaryMicGainDb(0);
        session.ingestSecondaryMic(frame(silence(2_000)), RATE, 0);
        session.setSecondaryMicLag(0);
      }
      return peakAt(drainAll(session, 1_600).mixed, 400, 1_000).value;
    };
    const alone = level(false);
    assert.ok(level(true) >= alone * 0.99, `gain sharing gives A the whole share (${level(true)} vs ${alone})`);
  });

  test('B fades in and out over 50 ms, and a detached B is dropped once silent', () => {
    const session = makeSession();
    session.start(0);
    session.ingestBacking(frame(silence(3_000)), RATE, 0);
    session.ingestMic(frame(silence(3_000)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 0 });
    session.attachSecondaryMic();
    session.setSecondaryMicGainDb(0);
    session.ingestSecondaryMic(frame(square(3_000, 16_000, 96)), RATE, 0);
    session.setSecondaryMicLag(0);

    // Two 20 ms frames into the fade: on the way, not there yet.
    drainAll(session, 600 + 20);
    const rising = session.secondaryMic!.blend;
    assert.ok(rising > 0 && rising < 1, `fading in (${rising})`);
    drainAll(session, 600 + 100);
    assert.equal(session.secondaryMic!.blend, 1);

    session.detachSecondaryMic();
    drainAll(session, 600 + 120);
    assert.ok(session.secondaryMic && session.secondaryMic.blend < 1, 'fading out, still attached');
    drainAll(session, 600 + 200);
    assert.equal(session.secondaryMic, null, 'dropped once fully silent');
  });

  test('a voice fading out is never revived: the next singer starts on a fresh track', () => {
    const session = makeSession();
    session.start(0);
    session.ingestBacking(frame(silence(3_000)), RATE, 0);
    session.ingestMic(frame(silence(3_000)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 0 });
    session.attachSecondaryMic();
    session.setSecondaryMicGainDb(6);
    session.ingestSecondaryMic(frame(square(3_000, 16_000, 96)), RATE, 0);
    session.setSecondaryMicLag(120);
    drainAll(session, 600 + 100);
    assert.equal(session.secondaryMic!.blend, 1);

    session.detachSecondaryMic();
    assert.equal(session.attachSecondaryMic(), false, 'the fading voice is not taken over');
    assert.equal(session.ingestSecondaryMic(frame(square(1_000, 16_000, 96), 2), RATE, 0), null,
      "the next singer's PCM never lands on the old track");
    drainAll(session, 600 + 200);
    assert.equal(session.secondaryMic, null, 'the old voice still fades out and is dropped');

    assert.equal(session.attachSecondaryMic(), true);
    const fresh = session.secondaryMic!;
    assert.equal(fresh.lagMs, null, "no lag carried over from the last singer");
    assert.equal(fresh.audible, false);
    assert.equal(fresh.blend, 0);
    assert.equal(fresh.bufferedSamples, 0);
  });

  test('B counts as heard only while its PCM reaches the mix', () => {
    const session = makeSession();
    session.start(0);
    session.ingestBacking(frame(silence(4_000)), RATE, 0);
    session.ingestMic(frame(silence(4_000)), RATE, 0);
    session.setAlignment({ calibratedMicLagMs: 0 });
    session.attachSecondaryMic();
    assert.equal(session.secondaryMic!.recentlyHeard, false, 'nothing mixed yet');
    session.setSecondaryMicGainDb(0);
    // One second of B, then B's media stops while B stays allowed to sound.
    session.ingestSecondaryMic(frame(square(1_000, 8_000, 96)), RATE, 0);
    session.setSecondaryMicLag(0);
    drainAll(session, 600 + 800);
    assert.equal(session.secondaryMic!.audible, true);
    assert.equal(session.secondaryMic!.recentlyHeard, true);
    drainAll(session, 600 + 2_000);
    assert.equal(session.secondaryMic!.audible, true, 'still allowed to sound');
    assert.equal(session.secondaryMic!.recentlyHeard, false, 'but nothing of B has reached the mix for a second');
  });

  test("a new mix epoch clears B's buffered PCM along with A's", () => {
    const session = makeSession();
    session.start(0);
    session.attachSecondaryMic();
    session.setSecondaryMicGainDb(0);
    session.ingestSecondaryMic(frame(silence(1_000)), RATE, 0);
    assert.ok(session.secondaryMic!.bufferedSamples > 0);
    session.resetEpoch(2_000);
    assert.equal(session.secondaryMic!.bufferedSamples, 0);
  });
});
