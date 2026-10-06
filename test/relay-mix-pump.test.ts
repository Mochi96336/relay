import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { MixFrameEvidence, MixFramePosition } from '../src/audio-session.js';
import type { MicAudibilityResult } from '../src/mic-audibility-monitor.js';
import type { PcmFrame } from '../src/pcm-frame.js';
import type { MicRuntime } from '../src/mic-runtime.js';
import type { TakeQualityFrameState } from '../src/take-quality.js';
import { createRelayMixPump, type RelayMixPumpScheduler } from '../src/relay-mix-pump.js';
import { functionCode, parseTypeScriptSource, sourceCode, variableInitializerCode } from './support/source-contract.js';

const frame = (first = 0): PcmFrame => ({ generation: 7, firstSampleIndex: first, pcm: Buffer.alloc(8) });
type FixtureQuality = TakeQualityFrameState & { now: number };

function fixture() {
  const calls: string[] = [];
  // The pump only tests whether this opaque transport exists; no receiver
  // behavior is simulated through a fabricated transport method.
  const transport = {} as NonNullable<MicRuntime['audioTransport']>;
  const state = {
    transport: true, sampleRate: 48_000 as number | null, active: true,
    samples: new Int16Array([12, 24]), start: 123, restarted: false,
    collecting: false, priming: false, driftChanged: false,
    estimate: { ppm: 12, windows: 3, spanMs: 100 } as { ppm: number; windows: number; spanMs: number } | null,
    audibility: null as MicAudibilityResult | null, levelChanged: false, askLevelContext: false,
    packets: [] as PcmFrame[], frames: [] as Array<{ pcm: Buffer; evidence: MixFrameEvidence; position: MixFramePosition }>,
    clock: 100, accepted: [] as PcmFrame[], ingested: [] as PcmFrame[],
    gainDb: -3,
    throwAt: null as string | null,
  };
  const note = (label: string) => {
    calls.push(label);
    if (state.throwAt === label) throw new Error(label);
  };
  const deps = {
    now() { const now = state.clock++; note(`clock:${now}`); return now; },
    mix: {
      get active() { note('mix.active'); return state.active; },
      get liveMicHeadroomMs() { note('mix.headroom'); return 250; },
      get micGainDb() { note('mix.gain'); return state.gainDb; },
      ingestMic(input: PcmFrame, rate: number | null, now: number) {
        note(`mix.ingest:${input.firstSampleIndex}:${rate}:${now}`);
        state.ingested.push(input);
        return { samples: state.samples, start: state.start, captureRestarted: state.restarted };
      },
      setMicClockTrimPpm(ppm: number | null) { note(`mix.trim:${ppm}`); },
      drain(emit: (pcm: Buffer, evidence: MixFrameEvidence, position: MixFramePosition) => void,
        ...unexpected: unknown[]) {
        assert.equal(unexpected.length, 0, 'pump must leave drain clock/maxFrames defaults alone');
        note('mix.drain');
        for (const output of state.frames) {
          assert.equal(emit(output.pcm, output.evidence, output.position), undefined, 'emit must remain synchronous');
        }
        return state.frames.length;
      },
    },
    mic: {
      get audioTransport() { note('mic.transport'); return state.transport ? transport : null; },
      get sampleRate() { note('mic.rate'); return state.sampleRate; },
      serviceRetransmits(now: number, headroom: number) { note(`mic.retransmits:${now}:${headroom}`); return 0; },
      flush(now: number) { note(`mic.flush:${now}`); return state.packets; },
      noteFrame(now: number, input: PcmFrame) { note(`mic.ack:${input.firstSampleIndex}:${now}`); state.accepted.push(input); },
    },
    audibility: {
      observeReceived(samples: Int16Array) { assert.equal(samples, state.samples); note('audibility.received'); },
      observeFrame(input: { micLive: boolean; frameSamples: number; micGapSamples: number; micStarvedSamples: number }) {
        assert.deepEqual(input, { micLive: true, frameSamples: 4, micGapSamples: 1, micStarvedSamples: 2 });
        note('audibility.frame'); return state.audibility;
      },
    },
    level: {
      observeReceived(samples: Int16Array) { assert.equal(samples, state.samples); note('level.received'); },
      reset() { note('level.reset'); },
      observeFrame(input: { micLive: boolean; frameSamples: number; heavyLimitedSamples: number },
        context: () => { songPlaying: boolean; micGainDb: number }) {
        assert.deepEqual(input, { micLive: true, frameSamples: 4, heavyLimitedSamples: 3 });
        note('level.frame');
        if (state.askLevelContext) assert.deepEqual(context(), { songPlaying: true, micGainDb: state.gainDb });
        return state.levelChanged;
      },
    },
    drift: {
      observe(generation: number, rate: number | null, end: number, now: number) {
        note(`drift.observe:${generation}:${rate}:${end}:${now}`); return state.driftChanged;
      },
      estimate() { note('drift.estimate'); return state.estimate; },
    },
    calibration: {
      get collecting() { note('calibration.collecting'); return state.collecting; },
      primeMic(samples: Int16Array, start: number) { assert.equal(samples, state.samples); note(`calibration.prime:${start}`); },
      observeMic(samples: Int16Array, start: number) { assert.equal(samples, state.samples); note(`calibration.observe:${start}`); },
    },
    validator: { observeMic(samples: Int16Array, start: number) {
      assert.equal(samples, state.samples); note(`validator.observe:${start}`);
    } },
    transition: { noteMicProgress() { note('transition.progress'); } },
    restart: { restart(input: { calibrationCollecting: boolean }) { note(`restart:${input.calibrationCollecting}`); } },
    take: { append(pcm: Buffer, quality: TakeQualityFrameState, evidence: MixFrameEvidence, position: MixFramePosition) {
      const output = state.frames.find((f) => f.pcm === pcm)!;
      assert.equal(evidence, output.evidence); assert.equal(position, output.position);
      note(`take.append:${position.firstSampleIndex}:${(quality as FixtureQuality).now}`); return true;
    } },
    monitor: { broadcast(pcm: string | Buffer, framed?: boolean, position?: MixFramePosition | null) {
      assert.ok(Buffer.isBuffer(pcm)); assert.ok(position);
      assert.equal(pcm, state.frames.find((f) => f.position === position)!.pcm);
      assert.equal(framed, true); note(`monitor:${position.firstSampleIndex}`); return 0;
    } },
    effects: {
      startLiveSource() { note('source.start'); state.active = true; },
      resetAudibility() { note('audibility.reset'); },
      fallbackPrimingActive() { note('fallback.priming'); return state.priming; },
      quality(now: number): FixtureQuality {
        note(`take.quality:${now}`);
        return { now, timingMode: 'network-estimate', calibrationStale: false,
          alignmentClamped: false, robotRoute: false, robotDeltaFresh: false, timingDivergenceMs: null };
      },
      micPlayable(now: number) { note(`mic.playable:${now}`); return true; },
      roomSongPlaying(now: number) { note(`song.playing:${now}`); return true; },
      reportAudibility(result: MicAudibilityResult, now: number) {
        assert.equal(result, state.audibility); note(`audibility.report:${now}`);
      },
      reportLevel(reason: string) { note(`level.report:${reason}`); },
      reportTimelineFolds() { note('folds.report'); },
    },
  };
  return { deps, state, calls };
}

function pump(f: ReturnType<typeof fixture>) {
  return createRelayMixPump(f.deps);
}

function output(first: number) {
  return { pcm: Buffer.alloc(8), position: { generation: 9, firstSampleIndex: first },
    evidence: { micGapSamples: 1, micStarvedSamples: 2, heavyLimitedSamples: 3 } as MixFrameEvidence };
}
const ingestTrace = (first: number, now: number) => [
  'mic.transport', 'mic.rate', 'mix.active', `clock:${now}`, 'mic.rate',
  `mix.ingest:${first}:48000:${now}`, `mic.ack:${first}:${now}`,
  'audibility.received', 'level.received', 'mic.rate', `drift.observe:7:48000:${first + 4}:${now}`,
  'fallback.priming', 'calibration.observe:123', 'validator.observe:123', 'transition.progress',
];
const emitTrace = (first: number, now: number) => [
  `clock:${now}`, `take.quality:${now}`, `take.append:${first}:${now}`, `monitor:${first}`,
  `mic.playable:${now}`, 'audibility.frame', `mic.playable:${now}`, 'level.frame',
];

test('tick drains without Mic transport and retains the drain defaults', () => {
  const f = fixture(); f.state.transport = false; pump(f).tick();
  assert.deepEqual(f.calls, ['mic.transport', 'mix.drain', 'folds.report']);
});
test('tick retransmits and flushes using one clock, then ingests multiple packets in order', () => {
  const f = fixture(); f.state.packets = [frame(0), frame(4)]; pump(f).tick();
  assert.deepEqual(f.calls, ['mic.transport', 'clock:100', 'mix.headroom',
    'mic.retransmits:100:250', 'mic.flush:100', ...ingestTrace(0, 101), ...ingestTrace(4, 102),
    'mix.drain', 'folds.report']);
  assert.deepEqual(f.state.ingested, f.state.packets);
  f.state.ingested.forEach((input, i) => assert.equal(input, f.state.packets[i]));
});
test('multiple drained frames retain individual clocks and Take/monitor identity', () => {
  const f = fixture(); f.state.frames = [output(0), output(4)]; pump(f).tick();
  assert.deepEqual(f.calls, ['mic.transport', 'clock:100', 'mix.headroom',
    'mic.retransmits:100:250', 'mic.flush:100', 'mix.drain',
    ...emitTrace(0, 101), ...emitTrace(4, 102), 'folds.report']);
});
for (const guard of ['transport', 'rate'] as const) {
  test(`ingest ${guard} guard produces no clock or effects`, () => {
    const f = fixture(); if (guard === 'transport') f.state.transport = false; else f.state.sampleRate = null;
    pump(f).ingest(frame());
    assert.deepEqual(f.calls, guard === 'transport' ? ['mic.transport'] : ['mic.transport', 'mic.rate']);
  });
}
test('inactive mix starts before the ingest clock is sampled', () => {
  const f = fixture(); f.state.active = false; pump(f).ingest(frame());
  const expected = ingestTrace(0, 100); expected.splice(3, 0, 'source.start');
  assert.deepEqual(f.calls, expected);
});
test('zero accepted samples do not acknowledge bytes but retain meter and timing observations', () => {
  const f = fixture(); f.state.samples = new Int16Array(); pump(f).ingest(frame());
  assert.deepEqual(f.calls, ingestTrace(0, 100).filter((call) => !call.startsWith('mic.ack')));
  assert.deepEqual(f.state.accepted, []);
});
test('ingest preserves independent live sample-rate reads for guard, ingest and drift', () => {
  const f = fixture();
  const rates = [48_000, 44_100, 32_000];
  Object.defineProperty(f.deps.mic, 'sampleRate', { get() {
    f.calls.push('mic.rate'); return rates.shift();
  } });
  pump(f).ingest(frame());
  const expected = ingestTrace(0, 100).map((call) => call
    .replace('mix.ingest:0:48000:100', 'mix.ingest:0:44100:100')
    .replace('drift.observe:7:48000:4:100', 'drift.observe:7:32000:4:100'));
  assert.deepEqual(f.calls, expected);
  assert.deepEqual(rates, []);
});
test('capture restart with no accepted samples retains cleanup but never claims live-flow proof', () => {
  const f = fixture(); f.state.restarted = true; f.state.samples = new Int16Array();
  pump(f).ingest(frame());
  assert.deepEqual(f.state.accepted, []);
  const expected = ingestTrace(0, 100).filter((call) => !call.startsWith('mic.ack'));
  expected.splice(expected.indexOf('fallback.priming'), 0,
    'audibility.reset', 'level.reset', 'calibration.collecting', 'restart:false');
  assert.deepEqual(f.calls, expected);
});
for (const missing of ['generation', 'firstSampleIndex'] as const) {
  test(`missing ${missing} does not advance clock-drift observation`, () => {
    const f = fixture(); const input = frame(); input[missing] = null; pump(f).ingest(input);
    assert.ok(!f.calls.some((call) => call.startsWith('drift.')));
    assert.equal(f.calls.filter((call) => call === 'mic.rate').length, 2);
    assert.equal(f.state.accepted[0], input);
  });
}
for (const ppm of [12, null] as const) {
  test(`closed drift window applies ${ppm} only after accepted ingest`, () => {
    const f = fixture(); f.state.driftChanged = true; if (ppm === null) f.state.estimate = null;
    pump(f).ingest(frame());
    const expected = ingestTrace(0, 100); expected.splice(11, 0, 'drift.estimate', `mix.trim:${ppm}`);
    assert.deepEqual(f.calls, expected);
  });
}
for (const collecting of [false, true]) {
  test(`capture restart cleanup settles before priming/consumers when collecting=${collecting}`, () => {
    const f = fixture(); Object.assign(f.state, { restarted: true, priming: true, collecting });
    pump(f).ingest(frame());
    const expected = ingestTrace(0, 100);
    expected.splice(11, 0, 'audibility.reset', 'level.reset', 'calibration.collecting', `restart:${collecting}`);
    expected.splice(expected.indexOf('fallback.priming') + 1, 0, 'calibration.prime:123');
    assert.deepEqual(f.calls, expected);
  });
}
test('level context remains lazy and reporting follows each monitor result', () => {
  const f = fixture(); f.state.frames = [output(0)];
  f.state.audibility = { events: [] } as unknown as MicAudibilityResult;
  f.state.levelChanged = true; f.state.askLevelContext = true; pump(f).tick();
  assert.deepEqual(f.calls.slice(6), ['clock:101', 'take.quality:101', 'take.append:0:101', 'monitor:0',
    'mic.playable:101', 'audibility.frame', 'audibility.report:101', 'mic.playable:101', 'level.frame',
    'song.playing:101', 'mix.gain', 'level.report:window', 'folds.report']);
});
for (const operation of ['take.append:0:101', 'monitor:0', 'audibility.frame', 'level.frame']) {
  test(`tick does not swallow ${operation} exceptions or continue after them`, () => {
    const f = fixture(); f.state.frames = [output(0)]; f.state.throwAt = operation;
    assert.throws(() => pump(f).tick(), new RegExp(operation));
    assert.equal(f.calls.at(-1), operation);
    assert.ok(!f.calls.includes('folds.report'));
  });
}

function fakeScheduler() {
  const scheduled: Array<{ callback: () => void; handle: ReturnType<typeof setInterval> }> = [];
  const cleared: Array<ReturnType<typeof setInterval>> = [];
  const scheduler: RelayMixPumpScheduler = {
    setInterval(callback, delayMs) {
      assert.equal(delayMs, 5);
      const handle = { id: scheduled.length } as unknown as ReturnType<typeof setInterval>;
      scheduled.push({ callback, handle });
      return handle;
    },
    clearInterval(handle) { cleared.push(handle); },
  };
  return { scheduler, scheduled, cleared };
}

test('construction performs no owner reads, effects or scheduling', () => {
  const f = fixture(); const timers = fakeScheduler(); createRelayMixPump(f.deps, timers.scheduler);
  assert.equal(f.calls.length, 0); assert.deepEqual(timers.scheduled, []); assert.deepEqual(timers.cleared, []);
});
test('repeated start schedules one 5ms callback without running it synchronously', () => {
  const f = fixture(); const timers = fakeScheduler(); const subject = createRelayMixPump(f.deps, timers.scheduler);
  subject.start(); subject.start();
  assert.equal(timers.scheduled.length, 1); assert.equal(f.calls.length, 0);
  timers.scheduled[0]!.callback();
  assert.deepEqual(f.calls, ['mic.transport', 'clock:100', 'mix.headroom',
    'mic.retransmits:100:250', 'mic.flush:100', 'mix.drain', 'folds.report']);
});
test('stop before start is inert and repeated stop clears exactly the live handle', () => {
  const f = fixture(); const timers = fakeScheduler(); const subject = createRelayMixPump(f.deps, timers.scheduler);
  subject.stop(); assert.deepEqual(timers.cleared, []);
  subject.start(); subject.stop(); subject.stop();
  assert.deepEqual(timers.cleared, [timers.scheduled[0]!.handle]); assert.equal(f.calls.length, 0);
});
test('a retired scheduler callback cannot emit a frame after stop or act on a restarted pump', () => {
  const f = fixture(); const timers = fakeScheduler(); const subject = createRelayMixPump(f.deps, timers.scheduler);
  f.state.frames = [output(0)]; subject.start(); subject.stop();
  const retired = timers.scheduled[0]!.callback;
  retired(); assert.equal(f.calls.length, 0);
  subject.start(); subject.start(); assert.equal(timers.scheduled.length, 2);
  retired(); assert.equal(f.calls.length, 0);
  timers.scheduled[1]!.callback();
  assert.equal(f.calls.filter((call) => call.startsWith('take.append')).length, 1);
  subject.stop(); assert.deepEqual(timers.cleared, timers.scheduled.map((timer) => timer.handle));
});

test('each requested level context samples the current gain rather than a constructor or prior-frame cache', () => {
  const f = fixture(); f.state.frames = [output(0)]; f.state.askLevelContext = true;
  const subject = pump(f); f.state.gainDb = 12.5; subject.tick();
  f.state.gainDb = 3.5; subject.tick();
  assert.equal(f.calls.filter((call) => call === 'mix.gain').length, 2);
  assert.ok(f.calls.indexOf('mix.gain') > f.calls.indexOf('level.frame'));
});

const serverUrl = new URL('../src/server.ts', import.meta.url);
const server = parseTypeScriptSource(serverUrl, readFileSync(serverUrl, 'utf8'));
const serverCode = sourceCode(server);

test('production pump bindings retain every canonical owner, clock and policy/effect port', () => {
  const binding = variableInitializerCode(server, 'relayMixPump');
  assert.match(binding, /^createRelayMixPump\(\{/);
  for (const fragment of ['now: () => performance.now()', 'mix: session', 'mic: micRuntime',
    'audibility: micAudibility', 'level: micLevel', 'drift: micClockDrift', 'calibration,',
    'validator: contentCalibrationValidator', 'transition: robotContentTransitionRuntime',
    'restart: { restart: relayMicLifecycle.restartCapture }', 'take: takeController', 'monitor: monitorTransport',
    'startLiveSource,', 'resetAudibility: resetMicAudibility',
    'fallbackPrimingActive: robotContentFallbackPrimingActive', 'quality: takeQualityFrameState',
    'micPlayable,', 'roomSongPlaying,', 'reportAudibility: reportMicAudibility',
    'reportLevel: reportMicLevel', 'reportTimelineFolds: reportMicTimelineFolds']) {
    assert.ok(binding.includes(fragment), `production binding missing ${fragment}`);
  }
  assert.doesNotMatch(serverCode, /processPublisherFrame|deliverMicPackets|noteMicFrame|mixerTimer|session\.drain\(|session\.ingestMic\(/);
});
test('pump starts exactly once at its composition point before awaited Opus, WT and HTTP listen', () => {
  const construction = serverCode.indexOf('const relayMixPump =');
  const start = serverCode.indexOf('relayMixPump.start();');
  const opus = serverCode.indexOf('await loadMonitorOpusEncoder(', start);
  const wt = serverCode.indexOf('await webTransportMedia.start(', opus);
  const listen = serverCode.indexOf('server.listen(', wt);
  assert.ok(construction >= 0 && start > construction && opus > start && wt > opus && listen > wt);
  assert.equal((serverCode.match(/relayMixPump\.start\(\)/g) ?? []).length, 1);
});
test('both close paths stop the same pump; graceful shutdown freezes mix before finalization', () => {
  assert.equal((serverCode.match(/relayMixPump\.stop\(\)/g) ?? []).length, 2);
  const closeStart = serverCode.indexOf("wss.on('close',");
  const closeEnd = serverCode.indexOf("server.on('error',", closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  assert.match(serverCode.slice(closeStart, closeEnd), /clearMicMediaAuthority\(\);\s*relayMixPump\.stop\(\);/);
  const shutdown = functionCode(server, 'gracefulShutdown');
  const fragments = ['shuttingDown = true', 'relayMixPump.stop()', 'await takeController.shutdown(Date.now())',
    'await webTransportMedia.stop()', 'client.terminate()', 'wss.close(', 'server.close('];
  let previous = -1;
  for (const fragment of fragments) {
    const index = shutdown.indexOf(fragment);
    assert.ok(index > previous, `shutdown must retain ordered ${fragment}`); previous = index;
  }
});
