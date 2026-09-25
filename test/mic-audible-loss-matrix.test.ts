/**
 * Audible loss matrix: the transport loss matrix's simulated network and real
 * page/Relay transports, with every frame MicRuntime emits mixed through a real
 * AudioSession (placement, concealment, Mic gain, limiter, bus) and the final
 * Int16 mix scored against the sung program it came from.
 *
 * The transport matrix proves packets arrive in time. This proves what the
 * room then hears: no clicks the program did not make, no clipping, no silence
 * the Take evidence does not account for, no buzz in concealed hiss, and every
 * lost packet still recorded as missing.
 *
 * MIC_LOSS_MATRIX_REPORT=1 prints each scenario's measurements.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import {
  burstyLoss,
  clean,
  PACKET_MS,
  randomLoss,
  simulateMicUplink,
  WARMUP_PACKETS,
  type Scenario,
} from './helpers/mic-loss-network.js';

const MIX_RATE = 48_000;
const MIX_FRAME_SAMPLES = 960;
/** Relay's production defaults for the live Mic path. */
const LIVE_PREBUFFER_MS = 400;
const LIVE_BACKING_GAIN = 0.65;
/** -28 dBFS raw: a phone held for singing, before Relay's +24 dB Mic gain. */
const SINGING_LEVEL = 0.04;

type Segment = 'vowel' | 'fricative' | 'transient' | 'square';
const CYCLE_S = 2;
const SEGMENT_STARTS: [number, Segment][] = [[0, 'vowel'], [0.8, 'fricative'], [1.2, 'transient'], [1.6, 'square']];

function segmentAt(t: number): Segment {
  const phase = ((t % CYCLE_S) + CYCLE_S) % CYCLE_S;
  let segment: Segment = 'vowel';
  for (const [start, name] of SEGMENT_STARTS) if (phase >= start) segment = name;
  return segment;
}

function hash01(n: number) {
  let x = Math.imul(n | 0, 0x9e37_79b1) ^ 0x85eb_ca6b;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b_3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a_2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 0x1_0000_0000;
}

const VOWEL_HARMONICS = [1, 0.8, 0.6, 0.9, 0.5, 0.3, 0.25, 0.35, 0.2, 0.12, 0.08, 0.05];
const VOWEL_SUM = VOWEL_HARMONICS.reduce((sum, value) => sum + value, 0);
/** Unvoiced hiss: many unrelated partials across 2.5-9 kHz, band-limited at any rate. */
const HISS = Array.from({ length: 64 }, (_, k) => ({
  hz: 2_500 + hash01(k * 3 + 1) * 6_500,
  phase: hash01(k * 3 + 2) * 2 * Math.PI,
}));

/**
 * A sung program as a function of continuous time, so any capture rate samples
 * the same signal and the 48 kHz mix can be scored against it exactly: a held
 * vowel with vibrato, unvoiced hiss, pings over a quiet vowel, and a reedy
 * note whose sign flips hard twice a period. Segments crossfade over 5 ms.
 */
function program(level: number) {
  const vowel = (t: number) => {
    const phase = 2 * Math.PI * 165 * (t - (0.02 / (2 * Math.PI * 5)) * Math.cos(2 * Math.PI * 5 * t));
    let value = 0;
    for (let k = 0; k < VOWEL_HARMONICS.length; k += 1) value += VOWEL_HARMONICS[k]! * Math.sin((k + 1) * phase);
    return (value / VOWEL_SUM) * 1.6;
  };
  const fricative = (t: number) => {
    let value = 0;
    for (const { hz, phase } of HISS) value += Math.sin(2 * Math.PI * hz * t + phase);
    return value * 0.06;
  };
  const transient = (t: number) => {
    const since = t % 0.1;
    const envelope = Math.min(1, since / 0.000_3) * Math.exp(-since / 0.004);
    return vowel(t) * 0.25 + envelope * Math.sin(2 * Math.PI * 2_500 * since) * 0.9;
  };
  const square = (t: number) => {
    let value = 0;
    for (let k = 1; k <= 15; k += 2) value += Math.sin(2 * Math.PI * 110 * k * t) / k;
    return value * 0.9;
  };
  const voices: Record<Segment, (t: number) => number> = { vowel, fricative, transient, square };
  const edgeS = 0.005;
  return (t: number) => {
    const current = voices[segmentAt(t)](t);
    const phase = ((t % CYCLE_S) + CYCLE_S) % CYCLE_S;
    const start = SEGMENT_STARTS.map(([at]) => at).filter((at) => at <= phase).at(-1)!;
    const into = phase - start;
    if (into >= edgeS) return current * level;
    const mix = into / edgeS;
    return (current * mix + voices[segmentAt(t - edgeS)](t) * (1 - mix)) * level;
  };
}

/** Strongest normalised autocorrelation at a 100 Hz-1 kHz lag: how buzzy it is. */
function tonality(samples: ArrayLike<number>) {
  let best = 0;
  for (let lag = 48; lag <= 480 && lag < samples.length / 2; lag += 1) {
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let i = lag; i < samples.length; i += 1) {
      dot += samples[i]! * samples[i - lag]!;
      a += samples[i]! * samples[i]!;
      b += samples[i - lag]! * samples[i - lag]!;
    }
    if (a > 0 && b > 0) best = Math.max(best, dot / Math.sqrt(a * b));
  }
  return best;
}

type Measurement = {
  scenario: string;
  missingPackets: number;
  evidenceGapMs: number;
  evidenceMissingMs: number;
  clicks: number;
  worstClick: { at: number; step: number; bound: number } | null;
  clippedSamples: number;
  evidenceClippedSamples: number;
  silentMs: number;
  unexplainedSilentMs: number;
  concealedHissTonality: number | null;
  receivedHissTonality: number;
};

type RunOptions = {
  sampleRate?: number;
  level?: number;
  seed?: number;
  /** Edits the mixed output before scoring: proves the scorer sees a fault. */
  tamper?: (output: number[], sourceTime: (i: number) => number) => void;
};

async function measure(
  scenario: Scenario,
  { sampleRate = 48_000, level = SINGING_LEVEL, seed = 1, tamper }: RunOptions = {},
) {
  const session = new AudioSession({
    sampleRate: MIX_RATE,
    frameMs: 20,
    prebufferMs: LIVE_PREBUFFER_MS,
    backingGain: LIVE_BACKING_GAIN,
    retentionMs: 3_000,
    backingRetentionMs: 3_000,
  });
  session.setMicExpected(true);
  session.setBackingExpected(false);
  session.start(0);
  const signal = program(level);
  const output: number[] = [];
  /** `missing` counts every Mic sample a Take records as absent: holes, concealment, starvation. */
  const frames: { start: number; gap: number; missing: number; clipped: number; advance: number }[] = [];
  const offsets = new Set<number>();

  const outcome = await simulateMicUplink({
    scenario,
    pageRetransmits: true,
    seed,
    sampleRate,
    pcm: (_index, first, count) => {
      const pcm = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i += 1) {
        pcm.writeInt16LE(Math.round(signal((first + i) / sampleRate) * 32_767), i * 2);
      }
      return pcm;
    },
    mixHeadroomMs: () => session.liveMicHeadroomMs,
    onFrames: (emitted, nowMs) => {
      for (const frame of emitted) {
        const placed = session.ingestMic(frame, sampleRate, nowMs);
        if (placed.samples.length > 0 && frame.firstSampleIndex !== null) {
          offsets.add(Math.round(placed.start - (frame.firstSampleIndex * MIX_RATE) / sampleRate));
        }
      }
    },
    onMixerTick: (nowMs) => {
      session.drain((frame, evidence) => {
        frames.push({
          start: output.length,
          gap: evidence.micGapSamples,
          missing: evidence.micGapSamples + evidence.micStarvedSamples + evidence.micUnavailableSamples,
          clipped: evidence.clippedSamples,
          advance: Math.round((session.appliedMicAdvanceMs * MIX_RATE) / 1_000),
        });
        for (let i = 0; i < frame.byteLength / 2; i += 1) output.push(frame.readInt16LE(i * 2) / 32_768);
      }, nowMs);
    },
  });

  // Output sample s is Mic timeline sample s + advance; timeline sample x holds
  // source time (x - offset) / 48 kHz, whatever rate captured it.
  assert.equal(offsets.size, 1, 'one capture keeps one placement offset');
  const [offset] = offsets as unknown as [number];
  const advanceAt = new Int32Array(output.length);
  for (const { start, advance } of frames) advanceAt.fill(advance, start, start + MIX_FRAME_SAMPLES);
  const sourceTime = (i: number) => (i + advanceAt[i]! - offset) / MIX_RATE;
  tamper?.(output, sourceTime);

  // Score the program from the end of the clean warm-up to its last packet.
  const scoreFrom = frames.find(({ start }) => sourceTime(start) >= (WARMUP_PACKETS * PACKET_MS) / 1_000 - 0.4)!.start;
  let scoreTo = output.length;
  while (scoreTo > scoreFrom && sourceTime(scoreTo - 1) > scenario.seconds - 0.02) scoreTo -= 1;
  const reference = new Float64Array(output.length);
  for (let i = 0; i < output.length; i += 1) reference[i] = signal(sourceTime(i));

  // Mic gain, measured on the untouched warm-up.
  let dot = 0;
  let power = 0;
  for (let i = scoreFrom; i < scoreFrom + MIX_RATE * 0.3; i += 1) {
    dot += output[i]! * reference[i]!;
    power += reference[i]! ** 2;
  }
  const gain = dot / power;

  // A click is an output step well past anything the program itself does
  // within 80 ms (a hole's concealment continues what came before it).
  const windowSamples = Math.round(MIX_RATE * 0.08);
  const referenceStep = new Float64Array(output.length);
  for (let i = 1; i < output.length; i += 1) referenceStep[i] = Math.abs(reference[i]! - reference[i - 1]!) * gain;
  const localStep = new Float64Array(output.length);
  const window: number[] = [];
  for (let i = 0; i < output.length + windowSamples; i += 1) {
    if (i < output.length) {
      while (window.length > 0 && referenceStep[window.at(-1)!]! <= referenceStep[i]!) window.pop();
      window.push(i);
    }
    const center = i - windowSamples;
    if (center < 0) continue;
    while (window[0]! < center - windowSamples) window.shift();
    localStep[center] = referenceStep[window[0]!]!;
  }
  let clicks = 0;
  let worstClick: Measurement['worstClick'] = null;
  let clippedSamples = 0;
  for (let i = scoreFrom + 1; i < scoreTo; i += 1) {
    const step = Math.abs(output[i]! - output[i - 1]!);
    const bound = localStep[i]! * 1.5 + 0.02;
    if (step > bound) {
      clicks += 1;
      if (!worstClick || step - bound > worstClick.step - worstClick.bound) worstClick = { at: i, step, bound };
    }
    if (Math.abs(output[i]!) >= 0.999) clippedSamples += 1;
  }

  // Silence: at least 1 ms of output that stays near zero while the program is
  // audible. Unexplained when no frame it touches reported any Mic sample
  // missing; a silence that starts in a hole may end in the next frame's fade-in.
  const scored = frames.filter(({ start }) => start >= scoreFrom && start + MIX_FRAME_SAMPLES <= scoreTo);
  let silentSamples = 0;
  let unexplainedSilentSamples = 0;
  let run: number[] = [];
  const closeRun = () => {
    let programPower = 0;
    for (const i of run) programPower += (reference[i]! * gain) ** 2;
    if (run.length >= 48 && Math.sqrt(programPower / run.length) > 0.02) {
      silentSamples += run.length;
      const firstFrame = Math.floor(run[0]! / MIX_FRAME_SAMPLES);
      const lastFrame = Math.floor(run.at(-1)! / MIX_FRAME_SAMPLES);
      const explained = frames.slice(firstFrame, lastFrame + 1).some(({ missing }) => missing > 0);
      if (!explained) unexplainedSilentSamples += run.length;
    }
    run = [];
  };
  for (let i = scoreFrom; i < scoreTo; i += 1) {
    if (Math.abs(output[i]!) < 0.002) run.push(i);
    else closeRun();
  }
  closeRun();

  // Buzz: concealed frames well inside the hiss, against received hiss frames.
  const concealedHiss: number[] = [];
  const receivedHiss: number[] = [];
  for (const { start, gap } of scored) {
    const inside = [start, start + MIX_FRAME_SAMPLES - 1].every((i) => segmentAt(sourceTime(i) - 0.03) === 'fricative'
      && segmentAt(sourceTime(i)) === 'fricative');
    if (!inside) continue;
    const frame = output.slice(start, start + MIX_FRAME_SAMPLES);
    if (gap >= MIX_FRAME_SAMPLES / 2 && frame.some((value) => Math.abs(value) > 0.01)) concealedHiss.push(tonality(frame));
    else if (gap === 0 && receivedHiss.length < 20) receivedHiss.push(tonality(frame));
  }

  const measurement: Measurement = {
    scenario: `${scenario.name}${sampleRate === 48_000 ? '' : ` @ ${sampleRate} Hz`}${level === SINGING_LEVEL ? '' : ` @ level ${level}`}`,
    missingPackets: outcome.missing,
    evidenceGapMs: Math.round((scored.reduce((sum, { gap }) => sum + gap, 0) / MIX_RATE) * 1_000),
    evidenceMissingMs: Math.round((scored.reduce((sum, { missing }) => sum + missing, 0) / MIX_RATE) * 1_000),
    clicks,
    worstClick,
    clippedSamples,
    evidenceClippedSamples: scored.reduce((sum, frame) => sum + frame.clipped, 0),
    silentMs: Math.round((silentSamples / MIX_RATE) * 1_000),
    unexplainedSilentMs: Math.round((unexplainedSilentSamples / MIX_RATE) * 1_000),
    concealedHissTonality: concealedHiss.length > 0 ? Math.max(...concealedHiss) : null,
    receivedHissTonality: Math.max(...receivedHiss),
  };
  if (process.env.MIC_LOSS_MATRIX_REPORT) console.log(JSON.stringify(measurement));
  return measurement;
}

function assertAudible(measurement: Measurement, { clickFree = true } = {}) {
  const context = JSON.stringify(measurement);
  if (clickFree) assert.equal(measurement.clicks, 0, `clicks the program never made: ${context}`);
  assert.equal(measurement.clippedSamples, 0, `the mix reached full scale: ${context}`);
  assert.equal(measurement.evidenceClippedSamples, 0, `the sum clamped: ${context}`);
  assert.equal(measurement.unexplainedSilentMs, 0, `silence the evidence does not account for: ${context}`);
  assert.ok(measurement.silentMs <= measurement.evidenceMissingMs, `more silence than missing audio: ${context}`);
  if (measurement.concealedHissTonality !== null) {
    assert.ok(
      measurement.concealedHissTonality <= Math.max(0.5, measurement.receivedHissTonality + 0.2),
      `concealed hiss turned into a tone: ${context}`,
    );
  }
  // Concealment is audible fill, never received audio: every packet that was
  // not heard in time must still be missing in what a Take records.
  const missingMs = measurement.missingPackets * PACKET_MS;
  assert.ok(measurement.evidenceMissingMs >= missingMs * 0.9, `lost audio not in the evidence: ${context}`);
}

const scenarios: { scenario: Scenario; options?: RunOptions; clickFree?: boolean }[] = [
  { scenario: { name: 'clean', seconds: 6, uplink: clean(40, 10), downlink: clean(40, 10) } },
  {
    scenario: {
      name: 'random 5% loss',
      seconds: 8,
      uplink: randomLoss(0.05, 40, 20),
      downlink: randomLoss(0.05, 40, 10),
    },
  },
  {
    scenario: {
      name: 'random 25% loss',
      seconds: 8,
      uplink: randomLoss(0.25, 40, 20),
      downlink: randomLoss(0.25, 40, 20),
    },
  },
  {
    scenario: {
      name: 'Gilbert bursts',
      seconds: 8,
      uplink: burstyLoss(0.02, 8, 40),
      downlink: randomLoss(0.01, 40, 10),
    },
  },
  {
    scenario: {
      name: 'every first repeat lost',
      seconds: 8,
      uplink: (rngs) => {
        const repeated = new Set<number>();
        return {
          delayMs: 40,
          jitterMs: 10,
          lose: (_nowMs, kind, sequence) => {
            if (kind === 'media') return rngs.media() < 0.08;
            if (repeated.has(sequence)) return false;
            repeated.add(sequence);
            return true;
          },
        };
      },
      downlink: clean(40, 10),
    },
  },
  {
    scenario: {
      name: 'request paths blink',
      seconds: 8,
      uplink: randomLoss(0.08, 40, 10),
      downlink: clean(40, 10),
      paths: (nowMs) => {
        const down = nowMs > 1_500 && nowMs % 500 < 60;
        return { direct: !down, control: !down };
      },
    },
  },
  {
    scenario: {
      // The phone changes networks at 3 s: WebTransport keeps accepting writes
      // for 400 ms that never arrive, then media moves to the WebSocket.
      name: 'WebTransport demoted to WebSocket',
      seconds: 8,
      uplink: (rngs) => ({
        delayMs: 40,
        jitterMs: 10,
        lose: (nowMs, kind) => (nowMs >= 3_000 && nowMs < 3_400) || (nowMs < 3_000 && rngs[kind]() < 0.03),
      }),
      downlink: clean(40, 10),
      paths: (nowMs) => ({ direct: nowMs < 3_000, control: true }),
      mediaPath: (nowMs) => (nowMs < 3_400 ? 'webtransport' : 'websocket'),
    },
  },
  {
    scenario: {
      name: 'page socket reconnects',
      seconds: 8,
      uplink: clean(40, 10),
      downlink: clean(40, 10),
      paths: (nowMs) => ({ direct: false, control: !(nowMs > 1_500 && nowMs % 1_500 < 120) }),
      pageSocketUp: (nowMs) => !(nowMs > 1_500 && nowMs % 1_500 < 120),
    },
  },
  {
    scenario: {
      name: 'round trip past the buffer',
      seconds: 8,
      uplink: randomLoss(0.08, 250, 30),
      downlink: randomLoss(0.08, 250, 30),
    },
  },
  {
    scenario: {
      name: 'random 15% loss',
      seconds: 8,
      uplink: randomLoss(0.15, 40, 20),
      downlink: randomLoss(0.15, 40, 20),
    },
    options: { sampleRate: 44_100 },
  },
  {
    // A loud singer: +10 dBFS into the limiter. The limiter's gain rides the
    // program, so the output is no longer a scaled copy and steps are not
    // scored; nothing may clip and the rest still holds.
    scenario: {
      name: 'random 25% loss',
      seconds: 8,
      uplink: randomLoss(0.25, 40, 20),
      downlink: randomLoss(0.25, 40, 20),
    },
    options: { level: 0.2 },
    clickFree: false,
  },
];

describe('Mic audible loss matrix (virtual clock, real transports and mix)', () => {
  for (const { scenario, options, clickFree } of scenarios) {
    const rate = options?.sampleRate ? ` at ${options.sampleRate / 1_000} kHz` : '';
    const loud = options?.level ? ' for a loud singer' : '';
    it(`sounds clean through ${scenario.name}${rate}${loud}`, async () => {
      assertAudible(await measure(scenario, options), { clickFree });
    });
  }

  it('scores a hard cut to silence that no evidence explains', async () => {
    // The scorer itself: 5 ms of a held vowel dropped to zero in the output.
    const measurement = await measure(scenarios[0]!.scenario, {
      tamper: (output, sourceTime) => {
        const at = output.findIndex((_, i) => sourceTime(i) >= 4.4);
        output.fill(0, at, at + 240);
      },
    });
    assert.ok(measurement.clicks > 0, 'the cut edges are clicks');
    assert.ok(measurement.unexplainedSilentMs >= 4, 'the cut is silence without evidence');
  });

  it('hears every packet on a clean path', async () => {
    const measurement = await measure(scenarios[0]!.scenario);
    assert.equal(measurement.missingPackets, 0);
    assert.equal(measurement.evidenceGapMs, 0);
    assert.equal(measurement.silentMs, 0);
  });
});
