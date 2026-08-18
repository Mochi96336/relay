const DEFAULT_INITIAL_PREBUFFER_MS = 100;
const DEFAULT_MIN_PREBUFFER_MS = 80;
const DEFAULT_MAX_PREBUFFER_MS = 250;
const DEFAULT_RECOVERY_STEP_MS = 50;
const DEFAULT_RECOVERY_WINDOW_MS = 1_000;
const DEFAULT_STABLE_STEP_MS = 10;
const DEFAULT_STABLE_WINDOW_MS = 30_000;
const DEFAULT_JITTER_SAFETY_FACTOR = 4;
const DEFAULT_JITTER_SPIKE_FACTOR = 1.5;
const DEFAULT_JITTER_SPIKE_CAP_MS = 60;
const DEFAULT_MAX_QUEUE_MS = 2_000;
const REPORT_INTERVAL_MS = 500;

// Listen starts with a small buffer and continuously measures PCM arrival
// variation. The estimator is RTP-like: compare each observed inter-arrival
// interval with the duration of the previous PCM chunk, then smooth the
// absolute deviation. Persistent jitter raises the target before an underrun;
// a shortfall remains a stronger fallback signal. Target reductions stay slow
// and never undercut the currently measured jitter requirement.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.playing = false;

    this.underruns = 0;
    this.droppedSamples = 0;
    this.starvedSamples = 0;
    this.reportCountdown = 0;
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;

    // AudioWorklet has a reliable render cadence even when message delivery is
    // bursty. Count render samples locally so tests and browsers share one clock.
    this.renderClockSamples = 0;
    this.lastArrivalClockSamples = null;
    this.lastArrivalChunkSamples = 0;
    this.arrivalJitterSamples = 0;
    this.lastArrivalDeviationSamples = 0;

    this.configure({});

    this.port.onmessage = (event) => {
      const data = event.data;

      if (data instanceof ArrayBuffer) {
        this.push(new Float32Array(data));
        return;
      }

      if (data?.type === 'reset') {
        this.reset();
        return;
      }

      if (data?.type === 'configure') {
        this.configure(data);
      }
    };
  }

  configure(options) {
    const configuredMaxMs = Number(options.maxPrebufferMs ?? options.prebufferMs);
    const maxPrebufferMs = Number.isFinite(configuredMaxMs)
      ? Math.max(1, configuredMaxMs)
      : DEFAULT_MAX_PREBUFFER_MS;

    const configuredMinMs = Number(options.minPrebufferMs);
    const minPrebufferMs = Math.min(
      maxPrebufferMs,
      Number.isFinite(configuredMinMs) ? Math.max(1, configuredMinMs) : DEFAULT_MIN_PREBUFFER_MS,
    );

    const configuredInitialMs = Number(options.initialPrebufferMs);
    const initialPrebufferMs = Math.max(
      minPrebufferMs,
      Math.min(
        maxPrebufferMs,
        Number.isFinite(configuredInitialMs) ? configuredInitialMs : DEFAULT_INITIAL_PREBUFFER_MS,
      ),
    );

    const configuredRecoveryStepMs = Number(options.recoveryStepMs);
    const configuredRecoveryWindowMs = Number(options.recoveryWindowMs);
    const configuredStableStepMs = Number(options.stableStepMs);
    const configuredStableWindowMs = Number(options.stableWindowMs);
    const configuredJitterSafetyFactor = Number(options.jitterSafetyFactor);
    const configuredJitterSpikeFactor = Number(options.jitterSpikeFactor);
    const configuredJitterSpikeCapMs = Number(options.jitterSpikeCapMs);
    const maxQueueMs = Number(options.maxQueueMs);

    this.minPrebufferSamples = Math.round((sampleRate * minPrebufferMs) / 1000);
    this.maxPrebufferSamples = Math.round((sampleRate * maxPrebufferMs) / 1000);
    this.prebufferSamples = Math.round((sampleRate * initialPrebufferMs) / 1000);
    this.recoveryStepSamples = Math.max(1, Math.round(
      (sampleRate * (Number.isFinite(configuredRecoveryStepMs)
        ? Math.max(1, configuredRecoveryStepMs)
        : DEFAULT_RECOVERY_STEP_MS)) / 1000,
    ));
    this.recoveryWindowSamples = Math.max(1, Math.round(
      (sampleRate * (Number.isFinite(configuredRecoveryWindowMs)
        ? Math.max(1, configuredRecoveryWindowMs)
        : DEFAULT_RECOVERY_WINDOW_MS)) / 1000,
    ));
    this.stableStepSamples = Math.max(1, Math.round(
      (sampleRate * (Number.isFinite(configuredStableStepMs)
        ? Math.max(1, configuredStableStepMs)
        : DEFAULT_STABLE_STEP_MS)) / 1000,
    ));
    this.stableWindowSamples = Math.max(1, Math.round(
      (sampleRate * (Number.isFinite(configuredStableWindowMs)
        ? Math.max(1, configuredStableWindowMs)
        : DEFAULT_STABLE_WINDOW_MS)) / 1000,
    ));
    this.jitterSafetyFactor = Number.isFinite(configuredJitterSafetyFactor)
      ? Math.max(1, configuredJitterSafetyFactor)
      : DEFAULT_JITTER_SAFETY_FACTOR;
    this.jitterSpikeFactor = Number.isFinite(configuredJitterSpikeFactor)
      ? Math.max(1, configuredJitterSpikeFactor)
      : DEFAULT_JITTER_SPIKE_FACTOR;
    this.jitterSpikeCapSamples = Math.max(1, Math.round(
      (sampleRate * (Number.isFinite(configuredJitterSpikeCapMs)
        ? Math.max(1, configuredJitterSpikeCapMs)
        : DEFAULT_JITTER_SPIKE_CAP_MS)) / 1000,
    ));

    this.maxQueueSamples = Math.round(
      (sampleRate * (Number.isFinite(maxQueueMs) ? maxQueueMs : DEFAULT_MAX_QUEUE_MS)) / 1000,
    );
    this.maxQueueSamples = Math.max(this.maxQueueSamples, this.maxPrebufferSamples * 2);
    this.reportEvery = Math.max(1, Math.round((sampleRate * REPORT_INTERVAL_MS) / (1000 * 128)));
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;
    this.resetArrivalObservation();
  }

  resetArrivalObservation() {
    this.lastArrivalClockSamples = null;
    this.lastArrivalChunkSamples = 0;
    this.arrivalJitterSamples = 0;
    this.lastArrivalDeviationSamples = 0;
  }

  reset() {
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.playing = false;
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;
    this.resetArrivalObservation();
    // Keep the learned target across a reconnect, but throw away raw timing
    // anchors so the first packet on a new transport cannot look like a huge gap.
  }

  jitterTargetSamples() {
    const smoothed = this.arrivalJitterSamples * this.jitterSafetyFactor;
    const recentSpike = Math.min(
      this.jitterSpikeCapSamples,
      this.lastArrivalDeviationSamples * this.jitterSpikeFactor,
    );
    return Math.min(
      this.maxPrebufferSamples,
      Math.max(this.minPrebufferSamples, Math.round(this.minPrebufferSamples + Math.max(smoothed, recentSpike))),
    );
  }

  observeArrival(samples) {
    const arrivalClock = this.renderClockSamples;
    if (this.lastArrivalClockSamples !== null && this.lastArrivalChunkSamples > 0) {
      const interval = arrivalClock - this.lastArrivalClockSamples;
      if (interval <= this.recoveryWindowSamples) {
        const deviation = Math.abs(interval - this.lastArrivalChunkSamples);
        this.lastArrivalDeviationSamples = deviation;
        // RFC 3550-style inter-arrival jitter EWMA (1/16 gain).
        this.arrivalJitterSamples += (deviation - this.arrivalJitterSamples) / 16;
      } else {
        // Long idle/link loss is not jitter evidence. Start a fresh arrival
        // baseline while preserving the learned target from earlier traffic.
        this.arrivalJitterSamples = 0;
        this.lastArrivalDeviationSamples = 0;
      }
    }
    this.lastArrivalClockSamples = arrivalClock;
    this.lastArrivalChunkSamples = samples.length;
    return this.jitterTargetSamples();
  }

  applyJitterTarget(targetSamples) {
    if (targetSamples <= this.prebufferSamples) return;
    this.prebufferSamples = targetSamples;
    this.stablePlaybackSamples = 0;
  }

  push(samples) {
    if (samples.length === 0) return;

    // Arrival jitter and underrun recovery are two observations about the same
    // packet. Compute both against the pre-arrival target, then make exactly one
    // adaptation decision; otherwise one late recovery packet can first raise
    // the jitter target and then add another recovery step on top of it.
    const jitterTarget = this.observeArrival(samples);
    if (this.pendingRecovery) {
      if (this.recoveryWaitSamples <= this.recoveryWindowSamples) {
        this.raisePrebuffer(jitterTarget);
      } else {
        this.applyJitterTarget(jitterTarget);
      }
      this.pendingRecovery = false;
      this.recoveryWaitSamples = 0;
    } else {
      this.applyJitterTarget(jitterTarget);
    }

    this.queue.push(samples);
    this.queuedSamples += samples.length;

    while (this.queuedSamples > this.maxQueueSamples && this.queue.length > 1) {
      const oldest = this.queue[0];
      const usable = oldest.length - this.offset;
      this.queue.shift();
      this.offset = 0;
      this.queuedSamples -= usable;
      this.droppedSamples += usable;
    }
  }

  raisePrebuffer(jitterTarget = this.jitterTargetSamples()) {
    const target = Math.min(
      this.maxPrebufferSamples,
      Math.max(jitterTarget, this.prebufferSamples + this.recoveryStepSamples),
    );
    if (target === this.prebufferSamples) return;
    this.prebufferSamples = target;
    this.stablePlaybackSamples = 0;
  }

  noteStablePlayback(samples) {
    const floor = this.jitterTargetSamples();
    if (this.prebufferSamples <= floor) return;
    this.stablePlaybackSamples += samples;
    if (this.stablePlaybackSamples < this.stableWindowSamples) return;

    this.prebufferSamples = Math.max(
      floor,
      this.prebufferSamples - this.stableStepSamples,
    );
    this.stablePlaybackSamples = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);
    this.renderClockSamples += output.length;

    if (!this.playing) {
      if (this.pendingRecovery) this.recoveryWaitSamples += output.length;
      if (this.queuedSamples < this.prebufferSamples) {
        this.report(output.length);
        return true;
      }
      this.playing = true;
      this.port.postMessage({ type: 'playing' });
    }

    let written = 0;
    while (written < output.length && this.queue.length > 0) {
      const chunk = this.queue[0];
      const available = chunk.length - this.offset;
      const count = Math.min(available, output.length - written);
      output.set(chunk.subarray(this.offset, this.offset + count), written);

      written += count;
      this.offset += count;
      this.queuedSamples -= count;

      if (this.offset === chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    if (written < output.length) {
      this.playing = false;
      this.underruns += 1;
      this.starvedSamples += output.length - written;
      this.stablePlaybackSamples = 0;
      this.pendingRecovery = true;
      this.recoveryWaitSamples = output.length - written;
      this.port.postMessage({ type: 'buffering' });
    } else {
      this.noteStablePlayback(output.length);
    }

    this.report(0);
    return true;
  }

  report(starved) {
    this.starvedSamples += starved;
    this.reportCountdown -= 1;
    if (this.reportCountdown > 0) return;
    this.reportCountdown = this.reportEvery;

    this.port.postMessage({
      type: 'health',
      queuedMs: (this.queuedSamples / sampleRate) * 1000,
      targetPrebufferMs: (this.prebufferSamples / sampleRate) * 1000,
      jitterTargetMs: (this.jitterTargetSamples() / sampleRate) * 1000,
      arrivalJitterMs: (this.arrivalJitterSamples / sampleRate) * 1000,
      arrivalDeviationMs: (this.lastArrivalDeviationSamples / sampleRate) * 1000,
      underruns: this.underruns,
      droppedMs: (this.droppedSamples / sampleRate) * 1000,
      starvedMs: (this.starvedSamples / sampleRate) * 1000,
      playing: this.playing,
    });
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
