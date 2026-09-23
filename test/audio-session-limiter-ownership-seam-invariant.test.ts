import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AudioSession, type MixFrameEvidence } from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = Math.round((RATE * FRAME_MS) / 1000);
const PREBUFFER_MS = 400;
const MIC_HZ = 220;
const MIC_AMPLITUDE = 12_000;
const BACKING_AMPLITUDE = 6_000;
const MAX_AUDIBLE_STEP = 3_000;

function tone(
  firstSample: number,
  count: number,
  hz: number,
  amplitude: number,
) {
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const sampleIndex = firstSample + index;
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * hz * sampleIndex) / RATE),
    );
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}

function micFrame(
  generation: number,
  firstSampleIndex: number,
  count: number,
): PcmFrame {
  return {
    generation,
    firstSampleIndex,
    pcm: tone(firstSampleIndex, count, MIC_HZ, MIC_AMPLITUDE),
  };
}

function backingFrame(firstSampleIndex: number, count: number): PcmFrame {
  return {
    generation: 1,
    firstSampleIndex,
    pcm: tone(firstSampleIndex, count, 110, BACKING_AMPLITUDE),
  };
}

function constantMicFrame(
  generation: number,
  firstSampleIndex: number,
  count: number,
  value: number,
): PcmFrame {
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    pcm.writeInt16LE(value, index * 2);
  }
  return { generation, firstSampleIndex, pcm };
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function maxAdjacentStep(buffers: Buffer[], firstComparedSample = 0) {
  let maximum = 0;
  let maximumAt = -1;
  let maximumFrom = 0;
  let maximumTo = 0;
  let previous: number | null = null;
  let sampleAt = 0;

  for (const buffer of buffers) {
    for (let index = 0; index < buffer.byteLength / 2; index += 1) {
      const current = buffer.readInt16LE(index * 2);
      if (previous !== null && sampleAt >= firstComparedSample) {
        const step = Math.abs(current - previous);
        if (step > maximum) {
          maximum = step;
          maximumAt = sampleAt;
          maximumFrom = previous;
          maximumTo = current;
        }
      }
      previous = current;
      sampleAt += 1;
    }
  }

  return { maximum, maximumAt, maximumFrom, maximumTo };
}

test('reconnected Backing cannot outrun two-source summing headroom', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 0,
    backingGain: 0.65,
    retentionMs: 3_000,
    backingRetentionMs: 3_000,
  });
  session.setMicExpected(true);
  session.setBackingExpected(true);
  session.setMicGainDb(24);
  session.start(0);

  // Keep both retained timelines well ahead so a reconnect can re-arm Backing
  // without this fixture depending on packet arrival timing.
  session.ingestMic(
    constantMicFrame(1, 0, RATE * 2, 1_000),
    RATE,
    0,
  );
  session.ingestBacking(
    constantMicFrame(1, 0, RATE * 2, 20_000),
    RATE,
    0,
  );

  // Let the normal two-source mix settle, then model a Backing disconnect long
  // enough for the 150 ms musical duck/headroom state to return to voice-only.
  session.drain(() => {}, 180, 100);
  session.setBackingExpected(false);
  session.drain(() => {}, 380, 100);
  assert.equal(session.health().clippedSamples, 0);

  // The retained Backing timeline is still present. Re-arming the same capture
  // makes song PCM audible on the very next frame, which must not beat the
  // two-source safety state back into place.
  session.setBackingExpected(true);
  const evidence: MixFrameEvidence[] = [];
  session.drain((_pcm, frameEvidence) => evidence.push(frameEvidence), 400, 1);

  assert.equal(evidence.length, 1);
  assert.equal(
    evidence[0]!.limitedSamples,
    0,
    'fixture Mic must stay below the limiter so this isolates Backing rejoin headroom',
  );
  assert.equal(
    evidence[0]!.clippedSamples,
    0,
    'reconnected Backing must not reach the final hard clamp while headroom is still ramping',
  );
});

test('bind-time Mic replacement does not inherit old capture limiter reduction', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 3_000,
    backingRetentionMs: 3_000,
  });
  session.setMicExpected(true);
  session.setMicGainDb(24);
  session.start(0);

  // Drive the old capture hard enough that the limiter settles far below unity.
  session.ingestMic(
    constantMicFrame(1, 0, FRAME_SAMPLES * 12, 12_000),
    RATE,
    0,
  );
  session.drain(() => {}, 180, 100);
  assert.ok(session.health().limitedSamples > 0, 'fixture must establish old-capture gain reduction');

  // Publisher activation has already proven a different capture. Its first
  // 20 ms packet spans session 200..220 ms and therefore owns the next output
  // frame; a second packet provides limiter look-ahead beyond that frame.
  session.retireMicCapture();
  session.ingestMic(
    constantMicFrame(2, 0, FRAME_SAMPLES, 400),
    RATE,
    220,
  );
  session.ingestMic(
    constantMicFrame(2, FRAME_SAMPLES, FRAME_SAMPLES, 400),
    RATE,
    240,
  );

  const resumed: Buffer[] = [];
  session.drain((pcm) => resumed.push(pcm), 200, 1);
  assert.equal(resumed.length, 1);

  const settledIndex = Math.round(RATE * 0.005);
  const actual = resumed[0]!.readInt16LE(settledIndex * 2);
  const expected = Math.round(400 * (10 ** (24 / 20)));
  assert.ok(
    Math.abs(actual - expected) < 150,
    `new capture inherited old limiter reduction: got ${actual}, expected ~${expected}`,
  );
});

test('in-band Mic generation restart resets limiter only when the audible boundary is crossed', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 40,
    backingGain: 1,
    retentionMs: 3_000,
    backingRetentionMs: 3_000,
  });
  session.setMicExpected(true);
  session.setMicGainDb(24);
  session.start(0);

  // Three old-capture frames end at session sample 2880 (60 ms).
  session.ingestMic(
    constantMicFrame(1, 0, FRAME_SAMPLES * 3, 12_000),
    RATE,
    20,
  );

  // A generation restart arriving at 80 ms anchors its first 20 ms capture
  // interval exactly at session 60..80 ms, preserving the old PCM before it.
  const replacement = session.ingestMic(
    constantMicFrame(2, 0, FRAME_SAMPLES, 400),
    RATE,
    80,
  );
  assert.equal(replacement.captureRestarted, true);
  session.ingestMic(
    constantMicFrame(2, FRAME_SAMPLES, FRAME_SAMPLES, 400),
    RATE,
    81,
  );

  const outputs: Buffer[] = [];
  session.drain((pcm) => outputs.push(pcm), 40, 1);
  session.drain((pcm) => outputs.push(pcm), 60, 1);
  session.drain((pcm) => outputs.push(pcm), 80, 1);
  assert.ok(session.health().limitedSamples > 0, 'old capture must be limited before the restart');

  // The next frame starts exactly on the retained restart boundary. Limiter
  // ownership changes here, not when replacement PCM was merely ingested.
  session.drain((pcm) => outputs.push(pcm), 100, 1);
  assert.equal(outputs.length, 4);

  const settledIndex = Math.round(RATE * 0.005);
  const actual = outputs[3]!.readInt16LE(settledIndex * 2);
  const expected = Math.round(400 * (10 ** (24 / 20)));
  assert.ok(
    Math.abs(actual - expected) < 150,
    `audible replacement inherited old limiter reduction: got ${actual}, expected ~${expected}`,
  );
});

test('Mic capture replacement resets raw meter ownership', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 3_000,
  });
  session.start(0);

  session.ingestMic(
    constantMicFrame(1, 0, FRAME_SAMPLES, 12_000),
    RATE,
    0,
  );
  assert.ok((session.health().micPeakDbfs ?? -Infinity) > -10);

  session.retireMicCapture();
  assert.equal(
    session.health().micPeakDbfs,
    null,
    'retired capture peak must not remain the current microphone level',
  );

  session.ingestMic(
    constantMicFrame(2, 0, FRAME_SAMPLES, 1_000),
    RATE,
    40,
  );
  const replacementPeak = session.health().micPeakDbfs;
  assert.ok(
    replacementPeak !== null && replacementPeak < -29 && replacementPeak > -31,
    `replacement meter still reflects the retired capture: ${replacementPeak}`,
  );
});

test('Mic limiter lookahead cannot let a replacement capture attenuate old PCM early', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 40,
    backingGain: 1,
    retentionMs: 3_000,
    backingRetentionMs: 3_000,
  });
  session.setMicExpected(true);
  session.setMicGainDb(24);
  session.start(0);

  session.ingestMic(
    constantMicFrame(1, 0, FRAME_SAMPLES * 3, 400),
    RATE,
    20,
  );

  const replacement = session.ingestMic(
    constantMicFrame(2, 0, FRAME_SAMPLES, 12_000),
    RATE,
    80,
  );
  assert.equal(replacement.captureRestarted, true);
  session.ingestMic(
    constantMicFrame(2, FRAME_SAMPLES, FRAME_SAMPLES, 12_000),
    RATE,
    81,
  );

  const outputs: Buffer[] = [];
  session.drain((pcm) => outputs.push(pcm), 40, 1);
  session.drain((pcm) => outputs.push(pcm), 60, 1);
  session.drain((pcm) => outputs.push(pcm), 80, 1);
  assert.equal(outputs.length, 3);

  const expectedOld = Math.round(400 * (10 ** (24 / 20)));
  const beforeLookahead = outputs[2]!.readInt16LE(700 * 2);
  const insideLookahead = outputs[2]!.readInt16LE(900 * 2);
  assert.ok(
    Math.abs(beforeLookahead - expectedOld) < 150,
    `old capture fixture is not at the expected level: ${beforeLookahead} vs ~${expectedOld}`,
  );
  assert.ok(
    Math.abs(insideLookahead - expectedOld) < 150,
    `replacement capture attenuated old PCM before the restart boundary: ${insideLookahead} vs ~${expectedOld}`,
  );
  assert.equal(
    session.health().limitedSamples,
    0,
    'replacement PCM must not own limiter lookahead before it becomes audible',
  );

  session.drain((pcm) => outputs.push(pcm), 100, 1);
  assert.equal(outputs.length, 4);
  assert.ok(session.health().limitedSamples > 0);
  assert.equal(session.health().clippedSamples, 0);
});

test('missing Mic output does not count limiter release as limited source samples', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 3_000,
  });
  session.setMicExpected(true);
  session.setMicGainDb(24);
  session.start(0);

  // Two hot real frames establish active gain reduction without starving the
  // limiter look-ahead on the first emitted frame.
  session.ingestMic(
    constantMicFrame(1, 0, FRAME_SAMPLES * 2, 12_000),
    RATE,
    0,
  );
  session.drain(() => {}, 0, 1);
  session.drain(() => {}, 20, 1);
  assert.ok(session.health().limitedSamples > 0, 'fixture must engage the limiter on real Mic PCM');

  // Ownership release leaves limiter state to decay naturally, but the next
  // frame contains no Mic source samples. Its output edge is a source fade to
  // silence, not fresh PCM being held down by the limiter.
  session.setMicExpected(false);
  const evidence: MixFrameEvidence[] = [];
  session.drain((_pcm, frameEvidence) => {
    evidence.push(frameEvidence);
  }, 40, 1);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.micUnavailableSamples, FRAME_SAMPLES);
  assert.equal(
    evidence[0]!.limitedSamples,
    0,
    'limiter release over unavailable silence must not be reported as limited source samples',
  );
});

test('seeded limiter and Mic ownership transitions stay output-continuous', () => {
  for (const seed of [0x12345678, 0x9e3779b9, 0xc0ffee, 0x5eed5eed]) {
    const random = seeded(seed);
    const session = new AudioSession({
      sampleRate: RATE,
      frameMs: FRAME_MS,
      prebufferMs: PREBUFFER_MS,
      backingGain: 0.65,
      retentionMs: 3_000,
      backingRetentionMs: 3_000,
    });

    session.setMicExpected(true);
    session.setBackingExpected(true);
    session.setMicGainDb(24);
    session.start(0);

    session.ingestBacking(
      backingFrame(0, RATE * 8),
      RATE,
      0,
    );

    let micGeneration = 1;
    let micCaptureCursor = RATE * 2;
    session.ingestMic(
      micFrame(micGeneration, 0, micCaptureCursor),
      RATE,
      0,
    );

    const outputs: Buffer[] = [];
    const recentActions: string[] = [];
    let micExpected = true;

    // The fixture intentionally starts with an already-hot sine. Its first
    // derivative is not a runtime transition, so establish one emitted frame
    // before randomized gain/ownership actions begin. The frame0→frame1 join
    // remains inside the invariant.
    session.drain((pcm) => outputs.push(pcm), PREBUFFER_MS, 1);

    for (let outputFrame = 1; outputFrame < 180; outputFrame += 1) {
      const nowMs = PREBUFFER_MS + outputFrame * FRAME_MS;
      const action = random();
      let actionLabel = 'none';

      if (action < 0.20) {
        const gainDb = -6 + Math.round(random() * 42);
        session.setMicGainDb(gainDb);
        actionLabel = `gain:${gainDb}`;
      } else if (action < 0.32) {
        micExpected = !micExpected;
        session.setMicExpected(micExpected);
        actionLabel = `expected:${micExpected}`;
      } else if (action < 0.42 && micExpected) {
        session.retireMicCapture();
        micGeneration += 1;
        micCaptureCursor = RATE;
        actionLabel = `replace:g${micGeneration}`;
        session.ingestMic(
          micFrame(micGeneration, 0, micCaptureCursor),
          RATE,
          nowMs,
        );
      } else if (action < 0.52 && micExpected) {
        session.retireMicCapture();
        micGeneration += 1;
        micCaptureCursor = 0;
        actionLabel = `retire:g${micGeneration}`;
      } else if (action < 0.62 && micExpected && session.micTotalSamples === 0) {
        session.ingestMic(
          micFrame(micGeneration, micCaptureCursor, RATE),
          RATE,
          nowMs,
        );
        micCaptureCursor += RATE;
        actionLabel = `restore:g${micGeneration}`;
      }

      if (
        micExpected
        && session.micTotalSamples > 0
        && session.health().micHeadroomMs < 500
      ) {
        session.ingestMic(
          micFrame(micGeneration, micCaptureCursor, RATE),
          RATE,
          nowMs,
        );
        micCaptureCursor += RATE;
      }

      recentActions.push(`f${outputFrame}:${actionLabel}`);
      if (recentActions.length > 180) recentActions.shift();
      session.drain((pcm) => outputs.push(pcm), nowMs, 1);
    }

    const health = session.health();
    assert.ok(
      health.limitedSamples > 0,
      `seed 0x${seed.toString(16)} never exercised the limiter`,
    );

    const {
      maximum,
      maximumAt,
      maximumFrom,
      maximumTo,
    } = maxAdjacentStep(outputs, FRAME_SAMPLES);
    const maximumFrame = Math.floor(maximumAt / FRAME_SAMPLES);
    const actionStart = Math.max(0, maximumFrame - 12);
    const actionTrace = recentActions.slice(actionStart, maximumFrame + 1).join(' ');
    assert.ok(
      maximum < MAX_AUDIBLE_STEP,
      `limiter/ownership seed 0x${seed.toString(16)} emitted ${maximumFrom} -> ${maximumTo} (step ${maximum}) at sample ${maximumAt}, frame ${maximumFrame}, offset ${maximumAt % FRAME_SAMPLES}; recent ${actionTrace}`,
    );
  }
});
