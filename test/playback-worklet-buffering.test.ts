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

test('de-clicks Listen underrun and recovery edges without hiding starvation', async () => {
  const processor = await makeProcessor({
    minPrebufferMs: 1,
    initialPrebufferMs: 1,
    maxPrebufferMs: 10,
  });

  processor.push(new Float32Array(160).fill(0.5));

  const first = outputBlock();
  processor.process([], first);
  const firstOutput = first[0][0];
  assert.ok(Math.abs(firstOutput[firstOutput.length - 1] - 0.5) < 1e-6);

  const second = outputBlock();
  processor.process([], second);
  const secondOutput = second[0][0];

  assert.equal(processor.underruns, 1);
  assert.equal(
    processor.starvedSamples,
    96,
    'de-click audio must not reduce the exact starvation sample count',
  );
  assert.ok(
    Math.abs(secondOutput[32] - secondOutput[31]) < 1e-6,
    'the first missing output sample continues the last real sample instead of jumping to zero',
  );
  assert.ok(
    Math.abs(secondOutput[127]) < 1e-6,
    'a 2 ms starvation tail reaches literal silence by the end of the quantum',
  );

  let maxFadeOutStep = 0;
  for (let index = 33; index < secondOutput.length; index += 1) {
    maxFadeOutStep = Math.max(
      maxFadeOutStep,
      Math.abs(secondOutput[index] - secondOutput[index - 1]),
    );
  }
  assert.ok(maxFadeOutStep < 0.01, `fade-out stepped by ${maxFadeOutStep}`);

  // The underrun raises this tiny test target to its configured 10 ms ceiling.
  processor.push(new Float32Array(samplesFromMs(10)).fill(0.5));
  const recovered = outputBlock();
  processor.process([], recovered);
  const recoveredOutput = recovered[0][0];

  assert.ok(Math.abs(recoveredOutput[0]) < 1e-6, 'recovery starts from the emitted silence');
  assert.ok(
    Math.abs(recoveredOutput[95] - 0.5) < 1e-6,
    'recovery reaches the real PCM level within the bounded 2 ms window',
  );
  assert.ok(
    Math.abs(recoveredOutput[96] - 0.5) < 1e-6,
    'PCM after the recovery edge is untouched',
  );
  assert.equal(
    processor.starvedSamples,
    96,
    'synthetic recovery fade is output-only and does not invent delivered media',
  );
});

test('continues a short Listen fade-out across the next render quantum', async () => {
  const processor = await makeProcessor({
    minPrebufferMs: 1,
    initialPrebufferMs: 1,
    maxPrebufferMs: 10,
  });

  // After one full render block, leave 100 real samples in the queue. The next
  // quantum therefore has only 28 missing samples: shorter than the 96-sample
  // 2 ms de-click window.
  processor.push(new Float32Array(RENDER_QUANTUM + 100).fill(0.5));
  processor.process([], outputBlock());

  const partial = outputBlock();
  processor.process([], partial);
  const partialOutput = partial[0][0];
  assert.equal(processor.starvedSamples, 28);
  assert.ok(
    partialOutput[127] > 0,
    'the short starvation tail cannot reach silence inside the same render quantum',
  );

  const waiting = outputBlock();
  processor.process([], waiting);
  const waitingOutput = waiting[0][0];
  assert.ok(
    Math.abs(waitingOutput[0] - partialOutput[127]) < 0.01,
    'the next render quantum continues the same fade instead of stepping to zero',
  );
  assert.ok(
    Math.abs(waitingOutput[67]) < 1e-6,
    'the remaining 68 fade samples reach silence before the quantum ends',
  );
  assert.ok(
    waitingOutput.slice(68).every((sample) => sample === 0),
    'output stays literal silence after the bounded fade completes',
  );
  assert.equal(
    processor.starvedSamples,
    28 + RENDER_QUANTUM,
    'waiting output remains fully charged as starvation even while its edge is de-clicked',
  );
});

test('de-clicks Listen queue-overflow catch-up without hiding dropped PCM', async () => {
  const processor = await makeProcessor({
    minPrebufferMs: 1,
    initialPrebufferMs: 1,
    maxPrebufferMs: 10,
    maxQueueMs: 20,
  });

  // Start on +0.5 and leave 128 stale samples from that chunk queued.
  processor.push(new Float32Array(256).fill(0.5));
  const beforeOverflow = outputBlock();
  processor.process([], beforeOverflow);
  assert.ok(
    beforeOverflow[0][0].every((sample) => Math.abs(sample - 0.5) < 1e-6),
  );
  assert.equal(processor.queuedSamples, 128);
  assert.equal(processor.playing, true);

  // A 20 ms -0.5 live-edge chunk makes the queue 1,088 samples. The 20 ms cap
  // is 960 samples here, so the remaining 128 stale +0.5 samples are dropped.
  processor.push(new Float32Array(samplesFromMs(20)).fill(-0.5));

  assert.equal(
    processor.droppedSamples,
    128,
    'catch-up still drops the exact same stale media span',
  );
  assert.equal(processor.queuedSamples, samplesFromMs(20));
  assert.equal(processor.playing, true, 'overflow catch-up does not force a rebuffer');

  const caughtUp = outputBlock();
  processor.process([], caughtUp);
  const output = caughtUp[0][0];

  assert.ok(
    Math.abs(output[0] - 0.5) < 1e-6,
    'the first catch-up sample continues the previously emitted waveform',
  );
  assert.ok(
    Math.abs(output[95] + 0.5) < 1e-6,
    'the bounded 2 ms crossfade reaches the new live edge',
  );
  assert.ok(
    output.slice(96).every((sample) => Math.abs(sample + 0.5) < 1e-6),
    'PCM after the catch-up edge is the untouched new live-edge audio',
  );

  let maximumStep = 0;
  for (let index = 1; index < 96; index += 1) {
    maximumStep = Math.max(maximumStep, Math.abs(output[index] - output[index - 1]));
  }
  assert.ok(maximumStep < 0.02, `overflow crossfade stepped by ${maximumStep}`);
  assert.equal(processor.underruns, 0);
  assert.equal(processor.starvedSamples, 0);
});

test('live timeline reset de-clicks queue discard and recovered Listen PCM', async () => {
  const processor = await makeProcessor({
    minPrebufferMs: 1,
    initialPrebufferMs: 1,
    maxPrebufferMs: 10,
  });

  // Leave stale positive PCM queued after one rendered block.
  processor.push(new Float32Array(256).fill(0.5));
  const beforeReset = outputBlock();
  processor.process([], beforeReset);
  assert.ok(
    beforeReset[0][0].every((sample) => Math.abs(sample - 0.5) < 1e-6),
    'pre-reset output establishes an audible +0.5 trajectory',
  );
  assert.equal(processor.queuedSamples, 128);

  processor.port.onmessage?.({
    data: { type: 'reset', deClick: true },
  });
  assert.equal(processor.queuedSamples, 0, 'timeline reset discards queued stale PCM immediately');
  assert.equal(processor.playing, false);

  const fadeOut = outputBlock();
  processor.process([], fadeOut);
  const fadeOutSamples = fadeOut[0][0];
  assert.ok(
    Math.abs(fadeOutSamples[0] - 0.5) < 1e-6,
    'first post-reset sample continues the last emitted trajectory',
  );
  assert.ok(
    Math.abs(fadeOutSamples[95]) < 1e-6,
    'live reset reaches silence within the bounded 2 ms de-click window',
  );
  assert.ok(
    fadeOutSamples.slice(96).every((sample) => sample === 0),
    'output remains literal silence after the reset fade completes',
  );

  // New live-edge PCM has the opposite sign so stale +0.5 queue leakage is
  // immediately visible. Rebuffer target is capped to 10 ms in this test.
  processor.push(new Float32Array(samplesFromMs(10)).fill(-0.5));
  const recovered = outputBlock();
  processor.process([], recovered);
  const recoveredSamples = recovered[0][0];

  assert.ok(Math.abs(recoveredSamples[0]) < 1e-6, 'recovery begins at emitted silence');
  assert.ok(
    Math.abs(recoveredSamples[95] + 0.5) < 1e-6,
    'new live-edge PCM fades fully in over 2 ms',
  );
  assert.ok(
    recoveredSamples.slice(96).every((sample) => Math.abs(sample + 0.5) < 1e-6),
    'only the new live-edge PCM survives the queue reset',
  );
});

test('ordinary playback reset remains a hard temporal reset', async () => {
  const processor = await makeProcessor({
    minPrebufferMs: 1,
    initialPrebufferMs: 1,
    maxPrebufferMs: 10,
  });

  processor.push(new Float32Array(128).fill(0.5));
  processor.process([], outputBlock());
  processor.port.onmessage?.({ data: { type: 'reset' } });

  assert.equal(processor.queuedSamples, 0);
  assert.equal(processor.silenceFadeRemainingSamples, 0);
  assert.equal(processor.recoveryFadeRemainingSamples, 0);
  assert.equal(processor.needsOutputRecoveryFade, false);
  assert.equal(processor.lastOutputSample, 0);
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

function sinePacketFactory(frequencyHz: number, amplitude: number) {
  let nextSample = 0;
  return (samples: number) => {
    const chunk = new Float32Array(samples);
    for (let i = 0; i < samples; i += 1) {
      chunk[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * (nextSample + i)) / SAMPLE_RATE);
    }
    nextSample += samples;
    return chunk;
  };
}

/**
 * 20 ms packets on a steady cadence, except that the link holds everything
 * sent during each stall and delivers it in one burst when the stall ends:
 * nothing is lost, so the page never sees a position gap to reset on.
 */
function runStalledLink(
  processor: any,
  { untilMs, stalls, packet }: {
    untilMs: number;
    stalls: { atMs: number; durationMs: number }[];
    packet: (samples: number) => Float32Array;
  },
  onQuantum?: (output: Float32Array) => void,
) {
  const frameSamples = samplesFromMs(20);
  let sentFrames = 0;
  let deliveredFrames = 0;
  const endSamples = samplesFromMs(untilMs);
  while (processor.renderClockSamples < endSamples) {
    const nowMs = (processor.renderClockSamples / SAMPLE_RATE) * 1000;
    while (sentFrames * 20 <= nowMs) sentFrames += 1;
    const stalled = stalls.some(({ atMs, durationMs }) => nowMs >= atMs && nowMs < atMs + durationMs);
    if (!stalled) {
      for (; deliveredFrames < sentFrames; deliveredFrames += 1) processor.push(packet(frameSamples));
    }
    const block = outputBlock();
    processor.process([], block);
    onQuantum?.(block[0][0]);
  }
}

test('gives back the latency a stalled link left queued once the target no longer needs it', async () => {
  const processor = await makeProcessor({ stableWindowMs: 2_000 });
  let afterBurstMs = 0;
  let lowMs = Infinity;
  runStalledLink(processor, {
    untilMs: 40_000,
    stalls: [{ atMs: 1_000, durationMs: 190 }],
    packet: (samples) => new Float32Array(samples).fill(0.1),
  }, () => {
    const queuedMs = (processor.queuedSamples / SAMPLE_RATE) * 1000;
    if (processor.renderClockSamples <= samplesFromMs(1_300)) afterBurstMs = queuedMs;
    if (processor.renderClockSamples > samplesFromMs(36_000)) lowMs = Math.min(lowMs, queuedMs);
  });
  assert.ok(afterBurstMs >= 150, `the stall should leave audio queued: ${afterBurstMs.toFixed(0)} ms`);

  const targetMs = (processor.prebufferSamples / SAMPLE_RATE) * 1000;
  assert.ok(processor.trimmedSamples > 0, 'excess latency was trimmed');
  assert.ok(
    lowMs <= targetMs + 20 + 1,
    `queue low point ${lowMs.toFixed(0)} ms should settle within the margin of target ${targetMs.toFixed(0)} ms`,
  );
  assert.equal(processor.underruns, 1, 'trimming never starves playback');
  assert.equal(processor.droppedSamples, 0, 'a trim is not an overflow drop');
});

test('never trims a queue that steady traffic keeps at its target', async () => {
  const processor = await makeProcessor();
  runStalledLink(processor, {
    untilMs: 20_000,
    stalls: [],
    packet: (samples) => new Float32Array(samples).fill(0.1),
  });
  assert.equal(processor.trimmedSamples, 0);
  assert.equal(processor.underruns, 0);
});

test('crossfades a latency trim instead of splicing the waveform', async () => {
  const processor = await makeProcessor({ stableWindowMs: 1_000 });
  const packet = sinePacketFactory(440, 0.5);
  const naturalStep = 0.5 * 2 * Math.PI * (440 / SAMPLE_RATE);
  let previous: number | null = null;
  let worstStep = 0;
  let trimmedBefore = 0;
  let sawTrim = false;
  runStalledLink(processor, {
    untilMs: 12_000,
    stalls: [{ atMs: 1_000, durationMs: 190 }],
    packet,
  }, (output) => {
    if (processor.trimmedSamples > trimmedBefore) sawTrim = true;
    trimmedBefore = processor.trimmedSamples;
    if (processor.underruns > 0 && processor.playing) {
      for (const sample of output) {
        if (previous !== null) worstStep = Math.max(worstStep, Math.abs(sample - previous));
        previous = sample;
      }
    } else {
      previous = null;
    }
  });

  assert.ok(sawTrim, 'the scenario must exercise a trim');
  assert.ok(
    worstStep <= naturalStep * 1.5 + 0.01,
    `worst step ${worstStep.toFixed(4)} against a natural step of ${naturalStep.toFixed(4)}`,
  );
});

test('health telemetry reports trimmed latency apart from overflow drops', async () => {
  const processor = await makeProcessor();
  processor.trimmedSamples = samplesFromMs(40);
  processor.reportCountdown = 0;
  processor.report(0);
  const health = processor.port.messages.findLast((message: any) => message?.type === 'health') as any;
  assert.equal(health.trimmedMs, 40);
  assert.equal(health.droppedMs, 0);
});

test('does not trim away the buffer a link that keeps stalling still needs', async () => {
  const stalls = Array.from({ length: 14 }, (_, index) => ({ atMs: 1_000 + index * 4_000, durationMs: 170 }));
  const run = async (options: Record<string, number>) => {
    const processor = await makeProcessor(options);
    runStalledLink(processor, {
      untilMs: 60_000,
      stalls,
      packet: (samples) => new Float32Array(samples).fill(0.1),
    });
    return processor;
  };

  const untrimmed = await run({ trimWindowMs: 1e9 });
  const trimmed = await run({});
  assert.ok(
    trimmed.underruns <= untrimmed.underruns,
    `trimming added underruns: ${trimmed.underruns} against ${untrimmed.underruns}`,
  );
});

function toneSamples(count: number, frequencyHz: number, amplitude = 0.5, phaseSamples = 0) {
  return Float32Array.from({ length: count }, (_, index) => (
    amplitude * Math.sin((2 * Math.PI * frequencyHz * (index + phaseSamples)) / SAMPLE_RATE)
  ));
}

function renderQuanta(processor: any, quanta: number) {
  const rendered: number[] = [];
  for (let quantum = 0; quantum < quanta; quantum += 1) {
    const block = outputBlock();
    processor.process([], block);
    rendered.push(...block[0][0]);
  }
  return rendered;
}

function largestStep(samples: number[], from = 1, to = samples.length) {
  let largest = 0;
  for (let index = Math.max(1, from); index < to; index += 1) {
    largest = Math.max(largest, Math.abs(samples[index] - samples[index - 1]));
  }
  return largest;
}

test('a short underrun in a sung note keeps the note going, then fades it out', async () => {
  const processor = await makeProcessor({ minPrebufferMs: 1, initialPrebufferMs: 1, maxPrebufferMs: 10 });
  // 220 Hz at 0.5 moves at most about 0.0144 per sample on its own.
  processor.push(toneSamples(samplesFromMs(60), 220));
  const rendered = renderQuanta(processor, 40);
  const starveAt = samplesFromMs(60);

  assert.equal(processor.underruns, 1);
  assert.ok(largestStep(rendered, 1, starveAt + samplesFromMs(40)) < 0.02, 'the note is continued without a step');
  const held = rendered.slice(starveAt, starveAt + samplesFromMs(10));
  const heldRms = Math.sqrt(held.reduce((sum, sample) => sum + sample ** 2, 0) / held.length);
  // The tone's own RMS is 0.354; a 2 ms fade to silence leaves about 0.12.
  assert.ok(heldRms > 0.33, `the first 10 ms keep the note at full level, RMS ${heldRms.toFixed(3)}`);
  assert.ok(
    rendered.slice(starveAt + samplesFromMs(40)).every((sample) => sample === 0),
    'concealment has faded to silence by 40 ms',
  );
  assert.equal(
    processor.starvedSamples,
    rendered.length - starveAt,
    'concealment is output only: every missing sample is still starvation',
  );
  processor.report(0);
  processor.reportCountdown = 0;
  processor.report(0);
  const health = processor.port.messages.filter((message: any) => message?.type === 'health').at(-1) as any;
  assert.ok(Math.abs(health.concealedMs - 40) < 0.1, `reported ${health.concealedMs} ms concealed`);
});

test('an underrun in noise keeps the plain 2 ms fade instead of a repeated buzz', async () => {
  const processor = await makeProcessor({ minPrebufferMs: 1, initialPrebufferMs: 1, maxPrebufferMs: 10 });
  let seed = 3;
  const noise = Float32Array.from({ length: samplesFromMs(60) }, () => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return ((seed >>> 8) / 0x1000000 - 0.5) * 0.6;
  });
  processor.push(noise);
  const rendered = renderQuanta(processor, 40);
  const starveAt = samplesFromMs(60);
  assert.ok(
    rendered.slice(starveAt + samplesFromMs(2)).every((sample) => sample === 0),
    'noise reaches silence within the 2 ms fade',
  );
  assert.equal(processor.concealedSamples, 0);
});

test('audio that returns during concealment takes over without a click', async () => {
  const processor = await makeProcessor({ minPrebufferMs: 1, initialPrebufferMs: 1, maxPrebufferMs: 10 });
  const first = samplesFromMs(60);
  processor.push(toneSamples(first, 220));
  const rendered = renderQuanta(processor, Math.ceil(first / RENDER_QUANTUM) + 4);
  // The stalled audio arrives 15 ms late, in phase with where it belongs.
  processor.push(toneSamples(samplesFromMs(40), 220, 0.5, first + samplesFromMs(15)));
  rendered.push(...renderQuanta(processor, 20));
  assert.ok(largestStep(rendered) < 0.03, `recovery stepped by ${largestStep(rendered)}`);
});
