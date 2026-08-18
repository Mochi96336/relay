import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SAMPLE_RATE = 48_000;
const RENDER_QUANTUM = 128;

type TrafficPacket = {
  atMs: number;
  durationMs: number;
};

async function makeProcessor(options: Record<string, number> = {}) {
  const source = await readFile(new URL('../public/playback-worklet.js', import.meta.url), 'utf8');
  let RegisteredProcessor: any = null;

  class MockAudioWorkletProcessor {
    port: {
      messages: unknown[];
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (message: unknown) => void;
    };

    constructor() {
      const messages: unknown[] = [];
      this.port = {
        messages,
        onmessage: null,
        postMessage: (message) => messages.push(message),
      };
    }
  }

  vm.runInNewContext(source, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    ArrayBuffer,
    Float32Array,
    Math,
    Number,
    sampleRate: SAMPLE_RATE,
    registerProcessor(_name: string, Processor: unknown) {
      RegisteredProcessor = Processor;
    },
  });

  assert.ok(RegisteredProcessor);
  const processor = new RegisteredProcessor();
  processor.configure({ prebufferMs: 250, maxQueueMs: 800, ...options });
  return processor;
}

function outputBlock() {
  return [[new Float32Array(RENDER_QUANTUM)]];
}

function samplesFromMs(ms: number) {
  return Math.round((SAMPLE_RATE * ms) / 1000);
}

function runUntilUnderrun(processor: any) {
  const before = processor.underruns;
  let guard = 10_000;
  while (processor.underruns === before && guard > 0) {
    processor.process([], outputBlock());
    guard -= 1;
  }
  assert.ok(guard > 0, 'expected playback to reach an underrun');
}

function runTraffic(processor: any, packets: TrafficPacket[], untilMs: number) {
  const events = packets
    .map((packet) => ({
      atSamples: samplesFromMs(packet.atMs),
      chunkSamples: samplesFromMs(packet.durationMs),
    }))
    .sort((a, b) => a.atSamples - b.atSamples);
  let next = 0;
  const endSamples = samplesFromMs(untilMs);

  const deliverDuePackets = () => {
    while (next < events.length && events[next].atSamples <= processor.renderClockSamples) {
      processor.push(new Float32Array(events[next].chunkSamples));
      next += 1;
    }
  };

  // Message delivery is observed only between real 128-sample render quanta.
  // A nominal 20 ms packet cadence therefore naturally appears as alternating
  // 18.67/21.33 ms intervals at 48 kHz instead of an impossible perfect clock.
  while (processor.renderClockSamples < endSamples) {
    deliverDuePackets();
    processor.process([], outputBlock());
  }
  deliverDuePackets();
}

function burstPackets(lastAtMs: number) {
  const packets: TrafficPacket[] = [{ atMs: 0, durationMs: 20 }];
  for (let atMs = 40; atMs <= lastAtMs; atMs += 40) {
    packets.push(
      { atMs, durationMs: 20 },
      { atMs, durationMs: 20 },
    );
  }
  return packets;
}

test('starts at 100 ms instead of the legacy 250 ms ceiling', async () => {
  const processor = await makeProcessor();
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);
  assert.equal(processor.maxPrebufferSamples, SAMPLE_RATE * 0.25);

  runTraffic(processor, [
    { atMs: 0, durationMs: 90 },
    { atMs: 90, durationMs: 20 },
  ], 100);

  assert.equal(processor.playing, true);
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);
});

test('raises the next rebuffer target after short underruns and caps at 250 ms', async () => {
  const processor = await makeProcessor();

  for (const expectedMs of [150, 200, 250, 250]) {
    processor.push(new Float32Array(processor.maxPrebufferSamples));
    runUntilUnderrun(processor);
    const beforeRecovery = processor.prebufferSamples;

    processor.push(new Float32Array(128));
    assert.ok(processor.prebufferSamples >= beforeRecovery);
    assert.equal(processor.prebufferSamples, SAMPLE_RATE * expectedMs / 1000);

    processor.reset();
  }
});

test('one late recovery packet cannot apply jitter pressure and the recovery step twice', async () => {
  const processor = await makeProcessor();
  const steadyPackets: TrafficPacket[] = [];
  for (let atMs = 0; atMs <= 120; atMs += 20) {
    steadyPackets.push({ atMs, durationMs: 20 });
  }

  runTraffic(processor, steadyPackets, 250);
  assert.equal(processor.underruns, 1);
  assert.equal(processor.pendingRecovery, true);
  assert.equal(processor.prebufferSamples, samplesFromMs(100));

  // The 260 ms recovery packet is both strong jitter evidence and the packet
  // that proves the underrun was short. Those are two views of one event, so
  // the target should be max(jitter target, +50 ms), not jitter target + 50 ms.
  runTraffic(processor, [{ atMs: 260, durationMs: 20 }], 270);

  assert.ok(processor.jitterTargetSamples() > samplesFromMs(100));
  assert.equal(processor.prebufferSamples, samplesFromMs(150));
});

test('does not ratchet latency upward after a long idle gap', async () => {
  const processor = await makeProcessor({ recoveryWindowMs: 10 });
  processor.push(new Float32Array(processor.maxPrebufferSamples));
  runUntilUnderrun(processor);
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);

  for (let i = 0; i < 4; i += 1) processor.process([], outputBlock());
  processor.push(new Float32Array(128));
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);
});

test('stable playback lowers the future rebuffer target slowly and reset keeps the learned target', async () => {
  const processor = await makeProcessor({ initialPrebufferMs: 150, stableWindowMs: 10 });
  processor.push(new Float32Array(SAMPLE_RATE * 0.2));

  for (let i = 0; i < 4; i += 1) processor.process([], outputBlock());
  assert.equal(processor.prebufferSamples, Math.round(SAMPLE_RATE * 0.14));

  processor.reset();
  assert.equal(processor.prebufferSamples, Math.round(SAMPLE_RATE * 0.14));
  assert.equal(processor.playing, false);
});

test('steady 20 ms traffic tolerates real render-quantum timing without fake buffer growth', async () => {
  const processor = await makeProcessor();
  const packets: TrafficPacket[] = [];
  for (let atMs = 0; atMs < 600; atMs += 20) {
    packets.push({ atMs, durationMs: 20 });
  }

  runTraffic(processor, packets, 600);

  const jitterMs = (processor.arrivalJitterSamples / SAMPLE_RATE) * 1000;
  assert.ok(jitterMs > 0, 'render quantization should be visible to the estimator');
  assert.ok(jitterMs < 2, `expected only render-quantum jitter, got ${jitterMs.toFixed(3)} ms`);
  assert.equal(processor.prebufferSamples, SAMPLE_RATE * 0.1);
  assert.equal(processor.underruns, 0);
  assert.equal(processor.playing, true);
});

test('bursty traffic raises the future target while real playback stays ahead of underrun', async () => {
  const processor = await makeProcessor();

  // Same average media rate, but every 40 ms two 20 ms packets arrive together.
  // The queue is genuinely consumed by process() throughout this simulation.
  runTraffic(processor, burstPackets(1_000), 900);

  const targetMs = (processor.prebufferSamples / SAMPLE_RATE) * 1000;
  assert.ok(targetMs > 100);
  assert.ok(targetMs < 250);
  assert.equal(processor.underruns, 0);
  assert.equal(processor.playing, true);
});

test('one extreme arrival spike cannot jump the target straight to the 250 ms ceiling', async () => {
  const processor = await makeProcessor();

  runTraffic(processor, [
    { atMs: 0, durationMs: 20 },
    { atMs: 220, durationMs: 20 },
  ], 230);

  const targetMs = (processor.prebufferSamples / SAMPLE_RATE) * 1000;
  assert.ok(targetMs > 100);
  assert.ok(targetMs <= 141);
});

test('long idle resets raw arrival jitter without forgetting the learned target', async () => {
  const processor = await makeProcessor({ recoveryWindowMs: 100 });
  runTraffic(processor, burstPackets(200), 220);

  const learnedTarget = processor.prebufferSamples;
  assert.ok(processor.arrivalJitterSamples > 0);
  assert.ok(learnedTarget > samplesFromMs(100));

  runTraffic(processor, [{ atMs: 500, durationMs: 20 }], 510);

  assert.equal(processor.arrivalJitterSamples, 0);
  assert.equal(processor.prebufferSamples, learnedTarget);
});

test('slow decay never lowers the learned target below current jitter pressure', async () => {
  const processor = await makeProcessor({ stableStepMs: 50, stableWindowMs: 1 });
  runTraffic(processor, burstPackets(200), 220);

  const floor = processor.jitterTargetSamples();
  processor.prebufferSamples = SAMPLE_RATE * 0.2;
  processor.noteStablePlayback(128);
  processor.noteStablePlayback(128);

  assert.ok(processor.prebufferSamples >= floor);
});

test('health telemetry exposes queue target and measured arrival jitter', async () => {
  const processor = await makeProcessor();
  runTraffic(processor, burstPackets(120), 130);

  processor.reportCountdown = 0;
  processor.report(0);
  const health = processor.port.messages.findLast((message: any) => message?.type === 'health') as any;

  assert.ok(health);
  assert.equal(typeof health.targetPrebufferMs, 'number');
  assert.equal(typeof health.jitterTargetMs, 'number');
  assert.equal(typeof health.arrivalJitterMs, 'number');
  assert.equal(typeof health.arrivalDeviationMs, 'number');
});
