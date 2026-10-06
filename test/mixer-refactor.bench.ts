import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop, setTimeout as delay } from 'node:timers/promises';

import { AudioSession, type MixFrameEvidence } from '../src/audio-session.js';
import { MicAudibilityMonitor } from '../src/mic-audibility-monitor.js';
import { MicLevelMonitor } from '../src/mic-level-monitor.js';
import { parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

// Test-only, deterministic CPU/resource cross-check. Run separately from FULL:
// node --expose-gc --import tsx test/mixer-refactor.bench.ts > /tmp/relay-A20-perf-pre.json
// Use --runs=1 for fixture smoke only; acceptance requires nine runs.
const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = 960;
const PREBUFFER_MS = 400;
const DURATION_MS = 8_000;
const names = ['ordinary', 'bounded-slew', 'retained-seam', 'gap-concealment', 'catch-up'] as const;
type Scenario = typeof names[number];
const runArgument = process.argv.find((arg) => arg.startsWith('--runs='));
const runs = runArgument ? Number(runArgument.slice(7)) : 9;
assert.ok(Number.isInteger(runs) && runs > 0);
const pumpMode = process.argv.find((arg) => arg.startsWith('--pump='))?.slice(7);
assert.ok(pumpMode === undefined || pumpMode === 'baseline' || pumpMode === 'candidate');
type BenchmarkPump = { tick(): void };
// Candidate loading is deferred until the owner exists. This does not import
// a .test.ts or start a server; the production factory must not start a timer.
const candidateFactory = pumpMode === 'candidate'
  ? ((await import(new URL('../src/relay-mix-pump.js', import.meta.url).href)).createRelayMixPump as
    (dependencies: unknown) => BenchmarkPump)
  : null;
const baselineTick = pumpMode === 'baseline'
  ? variableInitializerCode(parseTypeScriptSource(new URL('../src/server.ts', import.meta.url),
    readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')), 'mixerTimer')
  : null;

function measuredPump(session: AudioSession,
  emit: Parameters<AudioSession['drain']>[0], clock: { now: number; maxFrames: number }) {
  const audibility = new MicAudibilityMonitor({ sampleRate: RATE });
  const level = new MicLevelMonitor({ sampleRate: RATE });
  const mix = {
    get active() { return session.active; },
    get liveMicHeadroomMs() { return session.liveMicHeadroomMs; },
    get micGainDb() { return session.micGainDb; },
    ingestMic: session.ingestMic.bind(session), setMicClockTrimPpm: session.setMicClockTrimPpm.bind(session),
    drain: (callback: Parameters<AudioSession['drain']>[0]) => session.drain(callback, clock.now, clock.maxFrames),
  };
  const noEffect = () => {};
  const deps = {
    now: () => clock.now, mix, audibility, level,
    mic: { audioTransport: null, sampleRate: RATE, serviceRetransmits: () => 0,
      flush: () => [], noteFrame: noEffect },
    drift: { observe: () => false, estimate: () => null },
    calibration: { collecting: false, primeMic: noEffect, observeMic: noEffect },
    validator: { observeMic: noEffect }, transition: { noteMicProgress: noEffect },
    restart: { restart: noEffect },
    take: { append: (pcm: Buffer, _quality: unknown, evidence: MixFrameEvidence,
      position: Parameters<Parameters<AudioSession['drain']>[0]>[2]) => { emit(pcm, evidence, position); return true; } },
    monitor: { broadcast: () => 0 },
    effects: { startLiveSource: noEffect, resetAudibility: noEffect, fallbackPrimingActive: () => false,
      quality: () => ({}), micPlayable: () => true, roomSongPlaying: () => true,
      reportAudibility: noEffect, reportLevel: noEffect, reportTimelineFolds: noEffect },
  };
  if (candidateFactory) return candidateFactory(deps);
  assert.ok(baselineTick);
  let tick: (() => void) | undefined;
  const bindings = {
    session: mix, micRuntime: deps.mic, micAudibility: audibility, micLevel: level,
    takeController: deps.take, monitorTransport: deps.monitor, performance: { now: deps.now },
    deliverMicPackets: (packets: unknown[]) => assert.equal(packets.length, 0),
    takeQualityFrameState: deps.effects.quality, micPlayable: deps.effects.micPlayable,
    roomSongPlaying: deps.effects.roomSongPlaying, reportMicAudibility: noEffect,
    reportMicLevel: noEffect, reportMicTimelineFolds: noEffect,
    setInterval(callback: () => void, ms: number) { assert.equal(ms, 5); tick = callback; return 1; },
  };
  new Function(...Object.keys(bindings), `${baselineTick};`)(...Object.values(bindings));
  assert.ok(tick);
  return { tick };
}

function signal(amplitude: number, seed: number) {
  const pcm = Buffer.alloc((RATE * DURATION_MS / 1000) * 2);
  let state = seed >>> 0;
  for (let index = 0; index < pcm.length / 2; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const t = index / RATE;
    const value = Math.round(amplitude * (Math.sin(2 * Math.PI * 220 * t)
      + 0.4 * Math.sin(2 * Math.PI * 331 * t)) + (state / 0x1_0000_0000 - 0.5) * 4);
    pcm.writeInt16LE(value, index * 2);
  }
  return pcm;
}
const micInput = signal(700, 17);
const backingInput = signal(4_000, 29);
const fixtureHash = createHash('sha256').update(micInput).update(backingInput).digest('hex');

function fixture(name: Scenario) {
  const session = new AudioSession({ sampleRate: RATE, frameMs: FRAME_MS,
    prebufferMs: PREBUFFER_MS, backingGain: 0.65, retentionMs: 3_000,
    backingRetentionMs: 6_000 });
  session.start(0);
  session.setMicExpected(true);
  session.setBackingExpected(true);
  session.ingestBacking({ generation: 71, firstSampleIndex: 0, pcm: backingInput }, RATE, 0);
  let restarts = 0;
  const ingest = (generation: number, first: number, pcm: Buffer) => {
    if (session.ingestMic({ generation, firstSampleIndex: first, pcm }, RATE, 0).captureRestarted) restarts += 1;
  };
  if (name === 'retained-seam') {
    const seam = RATE * 4;
    ingest(1, 0, micInput.subarray(0, seam * 2));
    ingest(2, 0, micInput.subarray(seam * 2));
    assert.equal(restarts, 1);
    session.setAlignment({ calibratedMicLagMs: 100 });
  } else if (name === 'gap-concealment') {
    const start = RATE * 2;
    const end = start + FRAME_SAMPLES;
    ingest(1, 0, micInput.subarray(0, start * 2));
    ingest(1, end, micInput.subarray(end * 2));
    assert.ok(session.micConcealedSampleCount > 0, 'fixture must reach real concealment');
  } else {
    ingest(1, 0, micInput);
    if (name === 'bounded-slew') session.setAlignment({ calibratedMicLagMs: 100 });
  }
  return { session, restarts };
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
function distribution(values: number[]) {
  return { n: values.length, medianUs: quantile(values, 0.5),
    p95Us: quantile(values, 0.95), p99Us: quantile(values, 0.99), maxUs: Math.max(...values) };
}

async function execute(name: Scenario, measured: boolean) {
  // Fixture generation, ingestion, explicit GC and telemetry sampling are not
  // charged to drain timing. Do not read real recordings or advance real time.
  const { session, restarts } = fixture(name);
  (globalThis as { gc?: () => void }).gc?.();
  await yieldLoop();
  const heapBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  let gcCount = 0;
  let gcDurationMs = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) { gcCount += 1; gcDurationMs += entry.duration; }
  });
  if (measured) observer.observe({ entryTypes: ['gc'] });
  const eventLoop = monitorEventLoopDelay({ resolution: 1 });
  if (measured) { eventLoop.enable(); await delay(5); eventLoop.reset(); }
  const durations: number[] = [];
  let frames = 0;
  let gapSamples = 0;
  let checksum = 0;
  let maxSent = 0;
  let slewedFrames = 0;
  let backwardSeamVisits = 0;
  let forwardSeamVisits = 0;
  // Read-only fixture instrumentation outside measured drain; no production
  // export/getter and no wrapped per-sample algorithm just for the benchmark.
  const emittedHistory = session as unknown as { lastEmittedMicSourceSample: number | null };
  const emit = (pcm: Buffer, evidence: MixFrameEvidence) => {
    frames += 1;
    gapSamples += evidence.micGapSamples;
    // Cheap anti-elision/output oracle inside the realistic emit callback.
    // Full PCM correctness remains the unchanged golden suite's responsibility.
    checksum = (Math.imul(checksum, 31) + pcm.readInt16LE(0)
      + pcm.readInt16LE(pcm.length - 2) + evidence.micGapSamples) | 0;
  };
  const finalTick = PREBUFFER_MS + DURATION_MS - FRAME_MS;
  const step = name === 'catch-up' ? 100 : FRAME_MS;
  const ticks: number[] = [];
  for (let now = PREBUFFER_MS; now <= finalTick; now += step) ticks.push(now);
  if (ticks.at(-1) !== finalTick) ticks.push(finalTick);
  const clock = { now: 0, maxFrames: name === 'catch-up' ? 5 : 1 };
  const pump = pumpMode ? measuredPump(session, emit, clock) : null;
  for (let index = 0; index < ticks.length; index += 1) {
    const now = ticks[index]!;
    if (name === 'bounded-slew' && now === 1_400) session.slewCalibratedMicLagTo(160);
    if (name === 'retained-seam' && now === 4_320) session.setAlignment({ fineTuneMs: 160 });
    if (name === 'retained-seam' && now === 4_340) session.setAlignment({ fineTuneMs: -60 });
    const previousSource = emittedHistory.lastEmittedMicSourceSample;
    clock.now = now;
    const previousFrames = frames;
    const began = performance.now();
    if (pump) pump.tick();
    else session.drain(emit, now, name === 'catch-up' ? 5 : 1);
    const sent = frames - previousFrames;
    durations.push((performance.now() - began) * 1_000);
    maxSent = Math.max(maxSent, sent);
    const nextSource = emittedHistory.lastEmittedMicSourceSample;
    if (name === 'retained-seam' && previousSource !== null && nextSource !== null) {
      const seam = RATE * 4;
      if (previousSource >= seam && nextSource < seam) backwardSeamVisits += 1;
      if (previousSource < seam && nextSource >= seam) forwardSeamVisits += 1;
    }
    const lag = session.alignment.calibratedMicLagMs;
    if (name === 'bounded-slew' && lag !== null && lag > 100 && lag < 160) slewedFrames += sent;
    if (measured && index % 32 === 31) await yieldLoop();
  }
  await delay(5);
  await yieldLoop();
  const loop = { n: Number(eventLoop.count), p95Ms: eventLoop.percentile(95) / 1e6,
    p99Ms: eventLoop.percentile(99) / 1e6, maxMs: eventLoop.max / 1e6 };
  eventLoop.disable();
  observer.disconnect();
  const heapAfter = process.memoryUsage();
  assert.equal(frames, DURATION_MS / FRAME_MS);
  assert.equal(maxSent, name === 'catch-up' ? 5 : 1);
  if (name === 'bounded-slew') assert.ok(slewedFrames > 100);
  if (name === 'gap-concealment') assert.ok(gapSamples > 0);
  if (name === 'retained-seam') {
    assert.ok(backwardSeamVisits > 0, 'retained seam must be revisited backwards');
    assert.ok(forwardSeamVisits > 1, 'retained seam must be crossed forwards again');
  }
  const result = { scenario: name, drains: distribution(durations),
    exercises: { frames, maxSent, restarts, gapSamples, concealedSamples: session.micConcealedSampleCount,
      slewedFrames, backwardSeamVisits, forwardSeamVisits, checksum },
    gc: { count: gcCount, durationMs: gcDurationMs }, eventLoop: loop,
    // Heap deltas are allocation/retention observations, NOT exact allocation counts.
    memory: { heapDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
      externalDeltaBytes: heapAfter.external - heapBefore.external, rssBytes: heapAfter.rss },
    cpu: process.cpuUsage(cpuBefore) };
  session.stop();
  return result;
}

for (const name of names) for (let warm = 0; warm < 2; warm += 1) await execute(name, false);
const results: Array<Awaited<ReturnType<typeof execute>> & { run: number }> = [];
for (let run = 0; run < runs; run += 1) {
  for (const name of names) results.push({ run, ...await execute(name, true) });
}
const summaries = names.map((scenario) => {
  const subset = results.filter((result) => result.scenario === scenario);
  const medians = subset.map((result) => result.drains.medianUs);
  const median = quantile(medians, 0.5);
  for (const result of subset) assert.deepEqual(result.exercises, subset[0]!.exercises);
  return { scenario, runs: subset.length, drainSamples: subset.reduce((n, r) => n + r.drains.n, 0),
    medianRunMedianUs: median, madRunMedianUs: quantile(medians.map((v) => Math.abs(v - median)), 0.5) };
});
console.log(JSON.stringify({ schema: 1, node: process.version, platform: process.platform,
  arch: process.arch, cpuModel: os.cpus()[0]?.model, cpuCount: os.cpus().length,
  explicitGc: typeof (globalThis as { gc?: () => void }).gc === 'function',
  configuration: { RATE, FRAME_MS, PREBUFFER_MS, DURATION_MS, runs, warmups: 2 },
  measurement: pumpMode ? 'mix-pump-tick' : 'audio-session-drain', pumpMode: pumpMode ?? null,
  fixtureHash, harnessHash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  resourceUsage: process.resourceUsage(), summaries, results }, null, 2));
