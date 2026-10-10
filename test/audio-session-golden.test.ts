import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  AudioSession,
  type AudioSessionOptions,
  type IngestResult,
  type MixFrameEvidence,
} from '../src/audio-session.js';
import type { PcmFrame } from '../src/pcm-frame.js';

/**
 * A bit-exact record of what AudioSession does with fixed inputs.
 *
 * Each scenario drives the mixer through one family of live behaviour and
 * hashes everything observable from outside: every emitted frame with its
 * evidence and position, every ingest result, the public readers calibration
 * uses, and the telemetry the server reports, sampled every 100 ms.
 *
 * A refactor meant to change nothing must leave every digest unchanged. A
 * change meant to alter the audio updates the digests in the same commit, and
 * says why. The `exercises` checks keep each scenario honest: a scenario that
 * silently stopped reaching its path would otherwise keep passing.
 */

const RATE = 48_000;
const FRAME_MS = 20;

function makeSession(overrides: Partial<AudioSessionOptions> = {}) {
  return new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
    backingRetentionMs: 6_000,
    ...overrides,
  });
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

type Signal = (sourceIndex: number, sourceRate: number) => number;

/** A sung note: two partials, so a read landing on the wrong sample shows. */
function voice(amplitude: number): Signal {
  return (index, sourceRate) => {
    const t = index / sourceRate;
    return amplitude * (Math.sin(2 * Math.PI * 220 * t) + 0.4 * Math.sin(2 * Math.PI * 331 * t));
  };
}

/** A chord for the song, unrelated in pitch to the voice. */
const song: Signal = (index, sourceRate) => {
  const t = index / sourceRate;
  return 4_000 * (
    Math.sin(2 * Math.PI * 147 * t)
    + Math.sin(2 * Math.PI * 185 * t)
    + 0.7 * Math.sin(2 * Math.PI * 277 * t)
  );
};

function pcm(first: number, count: number, sourceRate: number, signal: Signal) {
  const buffer = Buffer.alloc(count * 2);
  for (let offset = 0; offset < count; offset += 1) {
    const value = Math.round(signal(first + offset, sourceRate));
    buffer.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), offset * 2);
  }
  return buffer;
}

type Delivery = { atMs: number; order: number; run: (nowMs: number) => void };

/**
 * A capture on a phone or the Robot: packets numbered on its own clock, each
 * delivered when the network lets it arrive.
 */
type CaptureSpec = {
  source: 'mic' | 'backing';
  generation: number;
  sourceRate: number;
  packetSamples: number;
  /** Wall time the first sample was captured. */
  startMs: number;
  endMs: number;
  /** First sample index on the capture's own clock. */
  firstIndex?: number;
  /** Positive runs the capture clock slow against the wall. */
  clockPpm?: number;
  /** Every `everyMs` of wall time the capture loses `lossMs` without numbering it. */
  loss?: { everyMs: number; lossMs: number };
  /** Network delay for a packet captured at `capturedAtMs`. */
  delayMs: (capturedAtMs: number) => number;
  jitterMs?: number;
  dropProbability?: number;
  /** Packets captured inside a window arrive together at its end. */
  stalls?: Array<{ fromMs: number; toMs: number }>;
  /** Packets captured inside a window never arrive. */
  outages?: Array<{ fromMs: number; toMs: number }>;
  /** Packet ordinals delivered twice. */
  duplicates?: number[];
  /** Sends PCM without a position header from this wall time until `untilMs`. */
  unheadered?: { fromMs: number; untilMs: number };
  trackSourceClock?: boolean;
  signal: Signal;
  seed: number;
};

class Scenario {
  readonly session: AudioSession;
  private readonly hash = createHash('sha256');
  private readonly deliveries: Delivery[] = [];
  private order = 0;
  private frames = 0;
  readonly exercises = {
    frames: 0,
    micGapSamples: 0,
    backingGapSamples: 0,
    micStarvedSamples: 0,
    micInputClippedSamples: 0,
    heavyLimitedSamples: 0,
    unheaderedSamples: 0,
    micRestarts: 0,
    backingRestarts: 0,
    maxCorrectionMs: 0,
    trimSamples: 0,
    concealedSamples: 0,
    folds: 0,
    backingClockCorrections: 0,
  };

  constructor(options: Partial<AudioSessionOptions> = {}) {
    this.session = makeSession(options);
  }

  at(atMs: number, run: (nowMs: number) => void) {
    this.deliveries.push({ atMs, order: this.order++, run });
  }

  note(label: string, value: unknown) {
    this.hash.update(`${label}:${JSON.stringify(value)}\n`);
  }

  capture(spec: CaptureSpec) {
    const next = random(spec.seed);
    const packetMs = (spec.packetSamples / spec.sourceRate) * 1000;
    const stretch = 1 + (spec.clockPpm ?? 0) / 1e6;
    let index = spec.firstIndex ?? 0;
    let capturedAtMs = spec.startMs;
    let nextLossAtMs = spec.loss ? spec.startMs + spec.loss.everyMs : Number.POSITIVE_INFINITY;
    let ordinal = 0;
    // The packet receiver releases a capture's packets in order; jitter delays
    // them but never reorders them.
    let lastArrivalMs = Number.NEGATIVE_INFINITY;
    while (capturedAtMs < spec.endMs) {
      capturedAtMs += packetMs * stretch;
      if (spec.loss && capturedAtMs >= nextLossAtMs) {
        capturedAtMs += spec.loss.lossMs;
        nextLossAtMs += spec.loss.everyMs;
      }
      const first = index;
      index += spec.packetSamples;
      ordinal += 1;
      const dropped = spec.dropProbability !== undefined && next() < spec.dropProbability;
      const jitter = (spec.jitterMs ?? 0) * next();
      if (dropped) continue;
      if (spec.outages?.some((window) => capturedAtMs >= window.fromMs && capturedAtMs < window.toMs)) continue;
      let arrivesAtMs = capturedAtMs + spec.delayMs(capturedAtMs) + jitter;
      const stall = spec.stalls?.find((window) => arrivesAtMs >= window.fromMs && arrivesAtMs < window.toMs);
      if (stall) arrivesAtMs = stall.toMs + (capturedAtMs - stall.fromMs) * 0.01;
      arrivesAtMs = Math.max(arrivesAtMs, lastArrivalMs);
      lastArrivalMs = arrivesAtMs;
      const unheadered = spec.unheadered !== undefined
        && capturedAtMs >= spec.unheadered.fromMs
        && capturedAtMs < spec.unheadered.untilMs;
      const frame: PcmFrame = {
        generation: unheadered ? null : spec.generation,
        firstSampleIndex: unheadered ? null : first,
        pcm: pcm(first, spec.packetSamples, spec.sourceRate, spec.signal),
      };
      const copies = spec.duplicates?.includes(ordinal) ? 2 : 1;
      for (let copy = 0; copy < copies; copy += 1) {
        this.at(arrivesAtMs + copy * 3, (nowMs) => {
          if (spec.source === 'mic') {
            this.ingested('mic', this.session.ingestMic(frame, spec.sourceRate, nowMs));
          } else {
            this.ingested('backing', this.session.ingestBacking(
              frame,
              spec.sourceRate,
              nowMs,
              spec.trackSourceClock ?? false,
            ));
          }
        });
      }
    }
  }

  private ingested(source: 'mic' | 'backing', result: IngestResult) {
    if (result.captureRestarted) {
      if (source === 'mic') this.exercises.micRestarts += 1;
      else this.exercises.backingRestarts += 1;
    }
    this.hash.update(`${source}:${result.start}:${result.captureRestarted}:`);
    this.hash.update(new Uint8Array(result.samples.buffer, result.samples.byteOffset, result.samples.byteLength));
  }

  /** The readers calibration and diagnostics use, at one moment. */
  readers(nowMs: number) {
    const s = this.session;
    const at = Math.round(s.sessionSampleAt(nowMs));
    const window = 4_800;
    const digest = (samples: Int16Array) => createHash('sha256')
      .update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
      .digest('hex');
    this.note('readers', {
      at,
      sessionSampleAt: s.sessionSampleAt(nowMs),
      mic: digest(s.readMic(at - 2 * window, window)),
      micEvidence: s.readMicEvidence(at - 2 * window, window),
      backing: digest(s.readBacking(at - 2 * window, window)),
      backingEvidence: s.readBackingEvidence(at - 2 * window, window),
    });
  }

  private telemetry() {
    const s = this.session;
    const health = s.health();
    this.exercises.maxCorrectionMs = Math.max(this.exercises.maxCorrectionMs, s.micFrontierCorrectionMs);
    if (s.micClockTrimSamples !== 0) this.exercises.trimSamples += 1;
    this.exercises.concealedSamples = s.micConcealedSampleCount;
    this.exercises.folds = s.micTimelineFoldCount;
    this.exercises.backingClockCorrections = Math.max(
      this.exercises.backingClockCorrections,
      health.backingClockCorrectionSamples,
    );
    this.note('telemetry', {
      health,
      correction: s.micFrontierCorrectionMs,
      applied: s.appliedMicAdvanceMs,
      requested: s.requestedMicAdvanceMs,
      concealed: s.micConcealedSampleCount,
      trim: s.micClockTrimSamples,
      trimPpm: s.micClockTrimPpm,
      folds: s.micTimelineFoldCount,
      lastFold: s.lastMicTimelineFold,
      micTotal: s.micTotalSamples,
      backingTotal: s.backingTotalSamples,
      headroom: s.liveMicHeadroomMs,
      micPlayable: s.micPlayable,
      backingPlayable: s.backingPlayable,
      micGeneration: s.micGeneration,
      backingGeneration: s.backingGeneration,
      generation: s.generation,
      alignment: s.alignment,
      target: s.calibratedMicLagTarget,
      gain: s.micGainDb,
      active: s.active,
    });
  }

  private emitted(frame: Buffer, evidence: MixFrameEvidence, position: unknown) {
    this.hash.update(frame);
    this.hash.update(JSON.stringify(evidence));
    this.hash.update(JSON.stringify(position));
    this.frames += 1;
    const e = this.exercises;
    e.frames += 1;
    e.micGapSamples += evidence.micGapSamples;
    e.backingGapSamples += evidence.backingGapSamples;
    e.micStarvedSamples += evidence.micStarvedSamples;
    e.micInputClippedSamples += evidence.micInputClippedSamples;
    e.heavyLimitedSamples += evidence.heavyLimitedSamples;
    e.unheaderedSamples += evidence.unheaderedSamples;
    if (this.frames % 5 === 0) this.telemetry();
  }

  run(untilMs: number) {
    const deliveries = [...this.deliveries].sort((a, b) => a.atMs - b.atMs || a.order - b.order);
    let next = 0;
    for (let nowMs = 0; nowMs <= untilMs; nowMs += 5) {
      while (next < deliveries.length && deliveries[next]!.atMs <= nowMs) {
        const delivery = deliveries[next]!;
        delivery.run(delivery.atMs);
        next += 1;
      }
      this.session.drain((frame, evidence, position) => this.emitted(frame, evidence, position), nowMs);
    }
    this.telemetry();
    return this.hash.digest('hex');
  }
}

const PHONE = { packetSamples: 480, jitterMs: 25 };
const ROBOT = { sourceRate: 48_000, packetSamples: 1_920 };

/** A Robot room for a whole song, with everything a singer can do to it. */
function steadyRoom() {
  const room = new Scenario();
  const { session } = room;
  room.at(0, (nowMs) => {
    session.start(nowMs);
    session.setBackingExpected(true);
  });
  room.capture({
    source: 'backing',
    generation: 71,
    ...ROBOT,
    startMs: 0,
    endMs: 40_000,
    clockPpm: 400,
    delayMs: () => 30,
    jitterMs: 6,
    dropProbability: 0.005,
    trackSourceClock: true,
    signal: song,
    seed: 1,
  });
  room.at(1_000, () => session.setAlignment({ fallbackMicLagMs: 137 }));
  room.at(3_000, () => session.setMicExpected(true));
  // The singer belts from 8 s to 12 s, hard enough to flatten the capture.
  const loud = voice(46_000);
  const normal = voice(700);
  room.capture({
    source: 'mic',
    generation: 1_001,
    sourceRate: 48_000,
    ...PHONE,
    startMs: 3_000,
    endMs: 40_000,
    delayMs: () => 70,
    dropProbability: 0.01,
    duplicates: [400, 1_200],
    signal: (index, rate) => {
      const atMs = 3_000 + (index / rate) * 1000;
      return atMs >= 8_000 && atMs < 12_000 ? loud(index, rate) : normal(index, rate);
    },
    seed: 2,
  });
  room.at(8_000, () => session.setMicGainDb(30));
  room.at(10_000, (nowMs) => room.readers(nowMs));
  room.at(12_000, () => session.setMicGainDb(18));
  room.at(14_000, () => session.setAlignment({ calibratedMicLagMs: 180 }));
  room.at(20_000, () => session.slewCalibratedMicLagTo(186));
  room.at(24_000, () => session.setAlignment({ fineTuneMs: 12 }));
  room.at(26_000, () => session.setMicClockTrimPpm(150));
  room.at(30_000, (nowMs) => room.readers(nowMs));
  room.at(31_000, () => session.setMicClockTrimPpm(-120));
  room.at(36_000, () => session.setMicClockTrimPpm(null));
  return { digest: room.run(40_000), exercises: room.exercises };
}

/** A phone whose audio arrives late, stalls, recovers, and drifts slow. */
function lateStalledRecovered() {
  const room = new Scenario();
  const { session } = room;
  room.at(0, (nowMs) => {
    session.start(nowMs);
    session.setMicExpected(true);
    session.setAlignment({ fallbackMicLagMs: 137 });
  });
  room.capture({
    source: 'mic',
    generation: 2_001,
    sourceRate: 48_000,
    ...PHONE,
    startMs: 0,
    endMs: 40_000,
    // On time, then suddenly 400 ms late, then on time again, then just inside
    // the window while the capture clock runs slow.
    delayMs: (capturedAtMs) => {
      if (capturedAtMs >= 5_000 && capturedAtMs < 18_000) return 470;
      if (capturedAtMs >= 24_000) return 230;
      return 70;
    },
    clockPpm: 0,
    stalls: [{ fromMs: 12_000, toMs: 12_800 }],
    outages: [{ fromMs: 33_000, toMs: 35_000 }],
    signal: voice(700),
    seed: 3,
  });
  room.at(15_000, (nowMs) => room.readers(nowMs));
  return { digest: room.run(40_000), exercises: room.exercises };
}

/** The gradual case on its own: a capture clock slow enough to spend the headroom. */
function slowCaptureClock() {
  const room = new Scenario();
  const { session } = room;
  room.at(0, (nowMs) => {
    session.start(nowMs);
    session.setMicExpected(true);
    session.setAlignment({ fallbackMicLagMs: 137 });
  });
  room.capture({
    source: 'mic',
    generation: 2_501,
    sourceRate: 48_000,
    ...PHONE,
    startMs: 0,
    endMs: 30_000,
    clockPpm: 2_000,
    delayMs: (capturedAtMs) => (capturedAtMs < 2_000 ? 70 : 290),
    jitterMs: 4,
    signal: voice(700),
    seed: 4,
  });
  return { digest: room.run(30_000), exercises: room.exercises };
}

/** A phone that keeps losing render time, which Relay folds once confirmed. */
function captureLossFolded() {
  const room = new Scenario({ retentionMs: 1_200 });
  const { session } = room;
  const generation = 3_001;
  room.at(0, (nowMs) => {
    session.start(nowMs);
    session.setMicExpected(true);
    session.setAlignment({ fallbackMicLagMs: 137 });
  });
  const loss = { everyMs: 4_000, lossMs: 220 };
  room.capture({
    source: 'mic',
    generation,
    sourceRate: 48_000,
    ...PHONE,
    startMs: 0,
    endMs: 40_000,
    loss,
    delayMs: () => 70,
    dropProbability: 0.004,
    signal: voice(700),
    seed: 5,
  });
  // The phone's own count confirms the loss once a second, until 28 s.
  for (let atMs = 1_000; atMs < 28_000; atMs += 1_000) {
    room.at(atMs, () => session.noteMicCaptureLoss(
      generation,
      Math.floor(atMs / loss.everyMs) * loss.lossMs,
    ));
  }
  room.at(20_000, (nowMs) => room.readers(nowMs));
  return { digest: room.run(40_000), exercises: room.exercises };
}

/** Captures replaced every way the server can replace them. */
function restartsAndHandovers() {
  const room = new Scenario();
  const { session } = room;
  room.at(0, (nowMs) => {
    session.start(nowMs);
    session.setBackingExpected(true);
    session.setMicExpected(true);
    session.setAlignment({ fallbackMicLagMs: 120 });
  });
  const backing = (generation: number, startMs: number, endMs: number, firstIndex = 0) => room.capture({
    source: 'backing',
    generation,
    ...ROBOT,
    startMs,
    endMs,
    firstIndex,
    delayMs: () => 30,
    jitterMs: 5,
    trackSourceClock: true,
    signal: song,
    seed: generation,
  });
  const phone = (
    generation: number,
    sourceRate: number,
    startMs: number,
    endMs: number,
    extra: Partial<CaptureSpec> = {},
  ) => room.capture({
    source: 'mic',
    generation,
    sourceRate,
    packetSamples: sourceRate / 100,
    jitterMs: 20,
    startMs,
    endMs,
    delayMs: () => 90,
    signal: voice(600 + (generation % 7) * 50),
    seed: generation,
    ...extra,
  });
  // In-band restart of the song capture, without registration in between.
  backing(81, 0, 20_000);
  backing(82, 20_050, 30_000);
  // In-band Mic restart: the new capture lands while the old one's audio is
  // still retained ahead of the read head.
  phone(4_001, 48_000, 0, 6_000);
  phone(4_002, 48_000, 6_050, 12_000);
  // Same generation, new source rate: a rebuilt capture graph. Its last
  // packet lands before the server retires it at bind, as a real retirement
  // rejects anything the old socket still had in flight.
  phone(4_002, 44_100, 12_050, 17_850);
  room.at(18_000, () => session.retireMicCapture());
  phone(4_003, 48_000, 18_300, 24_000);
  room.at(24_000, () => session.setMicExpected(false));
  room.at(26_000, () => session.setMicExpected(true));
  phone(4_004, 48_000, 26_000, 40_000, {
    unheadered: { fromMs: 34_000, untilMs: 34_500 },
  });
  room.at(30_000, () => session.setBackingExpected(false));
  room.at(32_000, () => {
    session.setBackingExpected(true);
    session.retireBackingCapture();
  });
  backing(83, 32_000, 40_000);
  room.at(36_000, () => session.clearMic());
  room.at(37_000, (nowMs) => session.resetEpoch(nowMs));
  room.at(38_000, (nowMs) => room.readers(nowMs));
  room.at(39_000, () => session.stop());
  room.at(39_500, (nowMs) => {
    session.start(nowMs);
    session.setMicExpected(true);
  });
  return { digest: room.run(41_000), exercises: room.exercises };
}

/** Captures at rates other than the mix rate, through the cubic resampler. */
function resampledCaptures() {
  const room = new Scenario();
  const { session } = room;
  room.at(0, (nowMs) => {
    session.start(nowMs);
    session.setBackingExpected(true);
    session.setMicExpected(true);
    session.setAlignment({ fallbackMicLagMs: 140 });
  });
  room.capture({
    source: 'backing',
    generation: 91,
    sourceRate: 44_100,
    packetSamples: 882,
    startMs: 0,
    endMs: 20_000,
    delayMs: () => 40,
    jitterMs: 8,
    signal: song,
    seed: 6,
  });
  room.capture({
    source: 'mic',
    generation: 5_001,
    sourceRate: 44_100,
    packetSamples: 441,
    startMs: 0,
    endMs: 10_000,
    delayMs: () => 80,
    jitterMs: 20,
    dropProbability: 0.02,
    unheadered: { fromMs: 6_000, untilMs: 6_500 },
    signal: voice(700),
    seed: 7,
  });
  room.capture({
    source: 'mic',
    generation: 5_002,
    sourceRate: 16_000,
    packetSamples: 160,
    startMs: 10_050,
    endMs: 20_000,
    delayMs: () => 80,
    jitterMs: 20,
    dropProbability: 0.02,
    signal: voice(700),
    seed: 8,
  });
  room.at(15_000, (nowMs) => room.readers(nowMs));
  return { digest: room.run(20_000), exercises: room.exercises };
}

test('golden: a steady Robot room with everything a singer does to it', () => {
  const { digest, exercises } = steadyRoom();
  assert.ok(exercises.concealedSamples > 0, 'conceals lost Mic packets');
  assert.ok(exercises.micInputClippedSamples > 0, 'attributes a flattened capture');
  assert.ok(exercises.heavyLimitedSamples > 0, 'limits the belted section hard');
  assert.ok(exercises.backingClockCorrections > 0, 'corrects the slow song clock');
  assert.ok(exercises.backingGapSamples > 0, 'declicks lost song packets');
  assert.ok(exercises.trimSamples > 0, 'trims the Mic capture clock');
  assert.equal(digest, 'fdf81b20d8d49dc3c6d2eedf7ba46b023c3af50986985b9a81e659ab5bd1bacf');
});

test('golden: late, stalled, recovered and silent Mic arrival', () => {
  const { digest, exercises } = lateStalledRecovered();
  assert.ok(exercises.maxCorrectionMs > 0, 'holds a late stream back');
  assert.ok(exercises.micStarvedSamples > 0, 'reports the outage as starvation');
  assert.equal(digest, '1b97f38f6f5991fe9ee7a282c2189d9be095fd3a70b0210ed671253a5a2a334c');
});

test('golden: a slow capture clock spending the headroom', () => {
  const { digest, exercises } = slowCaptureClock();
  assert.ok(exercises.maxCorrectionMs > 0, 'takes the gradual overrun');
  assert.equal(digest, '4d370e71e464e1f317c6d423718b0bf3a8e5276dc0ebccd5ebdd916f6448b7a2');
});

test('golden: confirmed capture loss folded into the timeline', () => {
  const { digest, exercises } = captureLossFolded();
  assert.ok(exercises.folds >= 2, 'folds confirmed loss more than once');
  assert.equal(digest, 'fe22f911626ca9f36c578f0aaa8d912b8d6b6ce02bea7ff845d9be3093665d0e');
});

test('golden: capture restarts, replacements and handovers', () => {
  const { digest, exercises } = restartsAndHandovers();
  assert.ok(exercises.micRestarts >= 2, 'restarts the Mic capture in band');
  assert.ok(exercises.backingRestarts >= 1, 'restarts the song capture in band');
  assert.ok(exercises.unheaderedSamples > 0, 'mixes unheadered PCM');
  assert.equal(exercises.maxCorrectionMs, 0, 'a Mic expected again is not chased into retained audio');
  assert.equal(digest, '8fa796e2efb6cc293b5fb0aa904c0acf97f6dcaef481d58f315dddb17cbf92c4');
});

test('golden: captures resampled to the mix rate', () => {
  const { digest, exercises } = resampledCaptures();
  assert.ok(exercises.micRestarts >= 1, 'changes capture rate mid-room');
  assert.ok(exercises.concealedSamples > 0, 'conceals loss at a resampled rate');
  assert.ok(exercises.unheaderedSamples > 0, 'resamples headerless PCM packet by packet');
  assert.equal(digest, '440a4ac56d694fa5832e5ff60afb6a4bdeb2121c942bf17ca4cf9eb4f026a8a1');
});
