/**
 * Offline Listen latency-trim A/B probe. Does not modify production behavior.
 *
 * Drives the actual public/playback-worklet.js with identical 48kHz PCM and
 * arrival times. The experimental path swaps ONLY observeQueueLatency:
 * it retires a correlated waveform period using bounded overlap-add, rather
 * than retiring the entire excess in one crossfade. Queue overflow remains the
 * existing hard bound. No result from this Node VM is a phone render-time claim.
 *
 * Usage:
 *   npm run experiment:listen-catchup
 *   npm run experiment:listen-catchup -- --out /tmp/listen-ab
 *   npm run experiment:listen-catchup -- --self-test
 *
 * --out writes source.wav, baseline.wav, experimental.wav and metrics.json.
 * Synthetic material is a reproducible harness, NOT evidence of user benefit.
 * A real-recording input and physical-device profiling are the next gates.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const RATE = 48_000;
const QUANTUM = 128;
const FRAME = 960;
const SECONDS = 14;
const BURST_AT_SECONDS = 4;
const BURST_FRAMES = 10;
const TRIM_WINDOW_MS = 500; // experiment only; production is 10,000 ms.
const WORKLET_FILE = fileURLToPath(new URL('../public/playback-worklet.js', import.meta.url));

function program(sample) {
  const time = sample / RATE;
  const note = Math.sin(2 * Math.PI * 165 * time + 0.08 * Math.sin(2 * Math.PI * 5 * time));
  const upper = 0.42 * Math.sin(2 * Math.PI * 330 * time);
  const pulsePhase = time % 0.5;
  const attack = pulsePhase < 0.025
    ? Math.exp(-pulsePhase / 0.005) * Math.sin(2 * Math.PI * 2_400 * pulsePhase)
    : 0;
  // Deterministic unvoiced segment tests the no-correlation path.
  const hash = Math.imul(sample ^ (sample >>> 11), 1_664_525) >>> 0;
  const hiss = ((hash / 0xffff_ffff) * 2 - 1) * 0.13;
  const phase = time % 2;
  return phase >= 0.85 && phase < 1.15
    ? hiss + note * 0.05
    : 0.24 * note + 0.12 * upper + 0.28 * attack;
}

function writePcm16Wav(samples) {
  const bytes = Buffer.allocUnsafe(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return bytes;
}

function retireHead(processor, count) {
  let remaining = count;
  while (remaining > 0 && processor.queue.length > 0) {
    const first = processor.queue[0];
    const available = first.length - processor.offset;
    const take = Math.min(available, remaining);
    processor.offset += take;
    processor.queuedSamples -= take;
    remaining -= take;
    if (processor.offset === first.length) {
      processor.queue.shift();
      processor.offset = 0;
    }
  }
  return count - remaining;
}

function experimentalLatencyTrim(events) {
  // This deliberately lives OUTSIDE public/playback-worklet.js. It is an
  // isolated candidate for auditory and deadline testing, not production DSP.
  return function observeQueueLatency(renderedSamples) {
    this.queueLatencyWindowSamples += renderedSamples;
    this.queueLatencyLowSamples = Math.min(this.queueLatencyLowSamples, this.queuedSamples);
    if (this.queueLatencyWindowSamples < this.trimWindowSamples) return;
    const excess = this.queueLatencyLowSamples - this.prebufferSamples;
    this.resetQueueLatencyWindow();
    if (excess <= this.trimMarginSamples || !this.playing) return;
    if (this.recoveryFadeRemainingSamples > 0 || this.trimFadeRemainingSamples > 0) return;

    const join = this.trimFadeSamples; // 5 ms already supported by Worklet.
    const minLag = Math.round(RATE / 400); // 2.5 ms
    const maxLag = Math.min(excess, Math.round(RATE / 60)); // 16.67 ms
    if (maxLag < minLag || this.queuedSamples < maxLag + join + this.prebufferSamples) return;

    const probe = new Float32Array(maxLag + join);
    if (this.readQueuedHead(probe, probe.length) !== probe.length) return;

    // Normalised, DC-free correlation of the same join window at both sides.
    let meanA = 0;
    for (let i = 0; i < join; i++) meanA += probe[i];
    meanA /= join;
    let energyA = 0;
    for (let i = 0; i < join; i++) energyA += (probe[i] - meanA) ** 2;
    if (energyA / join < 1e-8) return;

    let bestLag = 0;
    let bestScore = -1;
    const scoreAt = (lag) => {
      let meanB = 0;
      for (let i = 0; i < join; i++) meanB += probe[i + lag];
      meanB /= join;
      let dot = 0;
      let energyB = 0;
      for (let i = 0; i < join; i++) {
        const a = probe[i] - meanA;
        const b = probe[i + lag] - meanB;
        dot += a * b;
        energyB += b * b;
      }
      return energyB <= 1e-8 ? -1 : dot / Math.sqrt(energyA * energyB);
    };
    // Coarse + bounded local refinement; no unbounded render-thread search.
    for (let lag = minLag; lag <= maxLag; lag += 8) {
      const score = scoreAt(lag);
      if (score > bestScore || (score >= bestScore - 0.002 && lag > bestLag)) {
        bestLag = lag;
        bestScore = score;
      }
    }
    for (let lag = Math.max(minLag, bestLag - 8); lag <= Math.min(maxLag, bestLag + 8); lag++) {
      const score = scoreAt(lag);
      if (score > bestScore || (score >= bestScore - 0.002 && lag > bestLag)) {
        bestLag = lag;
        bestScore = score;
      }
    }
    // This is intentionally conservative: if the program is non-periodic,
    // postpone trim rather than inventing a splice. The production overflow
    // guard remains unchanged and is deliberately scored separately.
    if (bestScore < 0.86) return;

    // Reuse the current Worklet's established overlapping-crossfade output
    // path. Only the choice of what to remove is experimental.
    const overlap = this.readQueuedHead(this.trimFadeFrom, join);
    if (overlap === 0) return;
    const removed = retireHead(this, bestLag);
    this.trimmedSamples += removed;
    this.trimFadeTotalSamples = overlap;
    this.trimFadeRemainingSamples = overlap;
    events.push({ atOutputSample: this.renderClockSamples, removed, correlation: bestScore });
  };
}

async function makeProcessor(experiment, trimEvents) {
  const source = await readFile(WORKLET_FILE, 'utf8');
  let Constructor;
  class MockAudioWorkletProcessor {
    constructor() {
      this.port = { messages: [], onmessage: null, postMessage(message) { this.messages.push(message); } };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    ArrayBuffer, Float32Array, Math, Number, sampleRate: RATE,
    registerProcessor(_name, klass) { Constructor = klass; },
  }, { filename: 'playback-worklet.js' });
  assert.ok(Constructor);
  if (experiment) Constructor.prototype.observeQueueLatency = experimentalLatencyTrim(trimEvents);
  else {
    const original = Constructor.prototype.observeQueueLatency;
    Constructor.prototype.observeQueueLatency = function(...args) {
      const before = this.trimmedSamples;
      original.apply(this, args);
      if (this.trimmedSamples > before) {
        trimEvents.push({
          atOutputSample: this.renderClockSamples,
          removed: this.trimmedSamples - before,
          correlation: null,
        });
      }
    };
  }
  const processor = new Constructor();
  processor.configure({
    initialPrebufferMs: 100, minPrebufferMs: 80, maxPrebufferMs: 250,
    maxQueueMs: 2_000, trimWindowMs: TRIM_WINDOW_MS, trimMarginMs: 20,
  });
  return processor;
}

function localOutputStep(samples, atSample, length = 480) {
  const lo = Math.max(1, atSample - 5);
  const hi = Math.min(samples.length, atSample + length);
  let maximum = 0;
  for (let i = lo; i < hi; i++) maximum = Math.max(maximum, Math.abs(samples[i] - samples[i - 1]));
  return maximum;
}

async function simulate(experimental) {
  const events = [];
  const processor = await makeProcessor(experimental, events);
  const chunks = [];
  let sourceIndex = 0;
  const deliver = () => {
    const chunk = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) chunk[i] = program(sourceIndex++);
    processor.push(chunk);
  };
  // Prefill exactly the initial target. The late burst adds true, ordered
  // audio; no source data is artificially dropped or duplicated on arrival.
  for (let i = 0; i < 5; i++) deliver();
  let nextArrival = FRAME;
  let burstInjected = false;
  const output = new Float32Array(SECONDS * RATE);
  let outputAt = 0;
  let maxProcessMs = 0;
  while (processor.renderClockSamples < SECONDS * RATE) {
    const clock = processor.renderClockSamples;
    while (clock >= nextArrival) {
      deliver();
      nextArrival += FRAME;
    }
    if (!burstInjected && clock >= BURST_AT_SECONDS * RATE) {
      for (let i = 0; i < BURST_FRAMES; i++) deliver();
      burstInjected = true;
    }
    const block = new Float32Array(QUANTUM);
    const start = process.hrtime.bigint();
    processor.process([], [[block]]);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    maxProcessMs = Math.max(maxProcessMs, elapsedMs);
    output.set(block.subarray(0, Math.min(QUANTUM, output.length - outputAt)), outputAt);
    outputAt += QUANTUM;
  }
  const metrics = {
    mode: experimental ? 'candidate' : 'current',
    sourceSamples: sourceIndex,
    outputSamples: output.length,
    trimmedMs: (processor.trimmedSamples / RATE) * 1_000,
    droppedMs: (processor.droppedSamples / RATE) * 1_000,
    underruns: processor.underruns,
    starvedMs: (processor.starvedSamples / RATE) * 1_000,
    finalQueuedMs: (processor.queuedSamples / RATE) * 1_000,
    targetPrebufferMs: (processor.prebufferSamples / RATE) * 1_000,
    trimEvents: events.map(event => ({
      ...event,
      atOutputMs: (event.atOutputSample / RATE) * 1_000,
      edgeMaxStep: localOutputStep(output, event.atOutputSample),
    })),
    // Node VM measurements are only a relative regression signal, NOT an
    // AudioWorklet realtime or iPhone render-deadline proof.
    nodeVmWorstProcessMs: maxProcessMs,
  };
  return { output, metrics };
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex === -1 ? null : args[outIndex + 1];
if (outIndex !== -1 && !outDir) throw new Error('--out requires a directory');
const baseline = await simulate(false);
const candidate = await simulate(true);
if (args.includes('--self-test')) {
  assert.ok(baseline.metrics.trimmedMs > 0, 'fixture must exercise the real existing latency trim');
  assert.ok(candidate.metrics.trimEvents.length > 0, 'fixture must exercise the experimental overlap');
  assert.equal(baseline.output.length, candidate.output.length);
  assert.ok([...baseline.output, ...candidate.output].every(Number.isFinite));
  assert.equal(baseline.metrics.droppedMs, candidate.metrics.droppedMs,
    'normal-latency comparison must not silently change emergency queue overflow');
}
const report = {
  fixture: {
    sampleRate: RATE, seconds: SECONDS, burstAtMs: BURST_AT_SECONDS * 1_000,
    injectedExtraQueueMs: BURST_FRAMES * 20, experimentalTrimWindowMs: TRIM_WINDOW_MS,
  },
  current: baseline.metrics,
  candidate: candidate.metrics,
  caveats: [
    'This is a reproducible synthetic comparison, not proof of better listening quality.',
    'Correlation search runs in an offline Node VM, not on an actual mobile audio thread.',
    'This bounded proposal handles only normal latency trim; production overflow remains unchanged.',
    'Real music recordings and real-device measurements are required before enabling it in Listen.',
  ],
};
if (outDir) {
  await mkdir(outDir, { recursive: true });
  const source = new Float32Array(candidate.metrics.sourceSamples);
  for (let i = 0; i < source.length; i++) source[i] = program(i);
  await Promise.all([
    writeFile(path.join(outDir, 'source.wav'), writePcm16Wav(source)),
    writeFile(path.join(outDir, 'current.wav'), writePcm16Wav(baseline.output)),
    writeFile(path.join(outDir, 'candidate.wav'), writePcm16Wav(candidate.output)),
    writeFile(path.join(outDir, 'metrics.json'), JSON.stringify(report, null, 2) + '\n'),
  ]);
}
console.log(JSON.stringify(report, null, 2));
