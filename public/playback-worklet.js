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
const DEFAULT_TRIM_WINDOW_MS = 10_000;
const DEFAULT_TRIM_MARGIN_MS = 20;
const REPORT_INTERVAL_MS = 500;
const OUTPUT_GAP_DECLICK_MS = 2;
const TRIM_CROSSFADE_MS = 5;
// Underrun concealment: a periodic signal keeps its last pitch period going
// for CONCEAL_HOLD_MS, then fades to silence by CONCEAL_MAX_MS, so a brief
// stall sounds like a held note rather than a dropout. It needs a clear period
// in the last CONCEAL_HISTORY_MS of output; noise and DC keep the 2 ms fade.
const CONCEAL_HISTORY_MS = 30;
const CONCEAL_WINDOW_MS = 10;
const CONCEAL_MIN_PERIOD_HZ = 400;
const CONCEAL_MAX_PERIOD_HZ = 60;
const CONCEAL_MIN_CORRELATION = 0.8;
const CONCEAL_HOLD_MS = 10;
const CONCEAL_MAX_MS = 40;

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
    this.trimmedSamples = 0;
    this.starvedSamples = 0;
    this.reportCountdown = 0;
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;

    this.outputGapFadeSamples = Math.max(
      1,
      Math.round((sampleRate * OUTPUT_GAP_DECLICK_MS) / 1000),
    );
    this.silenceFadeRemainingSamples = 0;
    this.silenceFadeStartSample = 0;
    this.recoveryFadeRemainingSamples = 0;
    this.recoveryFadeStartSample = 0;
    this.needsOutputRecoveryFade = false;
    this.lastOutputSample = 0;
    // A latency trim crossfades the audio it skips into the audio it resumes
    // at, sample for sample, instead of from one held value.
    this.trimFadeSamples = Math.max(1, Math.round((sampleRate * TRIM_CROSSFADE_MS) / 1000));
    this.trimFadeFrom = new Float32Array(this.trimFadeSamples);
    this.trimFadeTotalSamples = 0;
    this.trimFadeRemainingSamples = 0;

    // The most recent real output, in a ring, for underrun concealment.
    this.historySamples = Math.max(1, Math.round((sampleRate * CONCEAL_HISTORY_MS) / 1000));
    this.history = new Float32Array(this.historySamples);
    this.historyWrite = 0;
    this.historyFilled = 0;
    this.concealCycle = null;
    this.concealPeriod = null;
    this.concealEmittedSamples = 0;
    this.concealHoldSamples = Math.round((sampleRate * CONCEAL_HOLD_MS) / 1000);
    this.concealMaxSamples = Math.round((sampleRate * CONCEAL_MAX_MS) / 1000);
    this.concealedSamples = 0;

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
        this.reset(data.deClick === true);
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
    const configuredTrimWindowMs = Number(options.trimWindowMs);
    const configuredTrimMarginMs = Number(options.trimMarginMs);

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
    this.trimWindowSamples = Math.max(1, Math.round(
      (sampleRate * (Number.isFinite(configuredTrimWindowMs)
        ? Math.max(1, configuredTrimWindowMs)
        : DEFAULT_TRIM_WINDOW_MS)) / 1000,
    ));
    this.trimMarginSamples = Math.max(0, Math.round(
      (sampleRate * (Number.isFinite(configuredTrimMarginMs)
        ? Math.max(0, configuredTrimMarginMs)
        : DEFAULT_TRIM_MARGIN_MS)) / 1000,
    ));
    this.reportEvery = Math.max(1, Math.round((sampleRate * REPORT_INTERVAL_MS) / (1000 * 128)));
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;
    this.resetArrivalObservation();
    this.resetQueueLatencyWindow();
  }

  resetQueueLatencyWindow() {
    this.queueLatencyWindowSamples = 0;
    this.queueLatencyLowSamples = Infinity;
  }

  resetArrivalObservation() {
    this.lastArrivalClockSamples = null;
    this.lastArrivalChunkSamples = 0;
    this.arrivalJitterSamples = 0;
    this.lastArrivalDeviationSamples = 0;
  }

  reset(deClick = false) {
    this.concealPeriod = null;
    this.historyFilled = 0;
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.playing = false;
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;
    this.trimFadeRemainingSamples = 0;

    if (deClick) {
      // A positioned monitor gap/generation jump must discard queued stale
      // audio immediately, but that does not require a one-sample jump to zero.
      // Preserve only the last emitted value long enough to taper the audible
      // edge; no queued PCM survives the reset.
      this.silenceFadeStartSample = this.lastOutputSample;
      this.silenceFadeRemainingSamples = this.outputGapFadeSamples;
      this.recoveryFadeRemainingSamples = 0;
      this.recoveryFadeStartSample = 0;
      this.needsOutputRecoveryFade = true;
    } else {
      this.silenceFadeRemainingSamples = 0;
      this.silenceFadeStartSample = 0;
      this.recoveryFadeRemainingSamples = 0;
      this.recoveryFadeStartSample = 0;
      this.needsOutputRecoveryFade = false;
      this.lastOutputSample = 0;
    }

    this.resetArrivalObservation();
    this.resetQueueLatencyWindow();
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

    let droppedForCatchUp = 0;
    while (this.queuedSamples > this.maxQueueSamples && this.queue.length > 1) {
      const oldest = this.queue[0];
      const usable = oldest.length - this.offset;
      this.queue.shift();
      this.offset = 0;
      this.queuedSamples -= usable;
      this.droppedSamples += usable;
      droppedForCatchUp += usable;
    }

    if (droppedForCatchUp > 0) this.resetQueueLatencyWindow();
    if (droppedForCatchUp > 0 && this.playing) {
      // Queue overflow is an intentional live-edge catch-up, but jumping from
      // the last emitted sample straight into the newer queue creates a click.
      // Keep the exact same drop policy and latency bound; smooth only the next
      // audible edge over the existing bounded recovery window.
      this.beginRecoveryFade();
    }
  }

  /**
   * Gives back latency the target no longer asks for.
   *
   * A link that stalls without losing anything delivers the stall all at once
   * afterwards, and that audio then plays late for as long as the room stays
   * connected: the target decays, but nothing short of an underrun or the
   * overflow bound ever shortens the queue itself. So watch the queue's low
   * point, the latency arrival jitter never needed, and once it has stayed
   * above the target for a whole window, drop that excess from the oldest
   * audio, crossfading what it skips into where it resumes. A listener clock
   * slower than Relay's builds up the same way and is trimmed the same way.
   */
  observeQueueLatency(renderedSamples) {
    this.queueLatencyWindowSamples += renderedSamples;
    this.queueLatencyLowSamples = Math.min(this.queueLatencyLowSamples, this.queuedSamples);
    if (this.queueLatencyWindowSamples < this.trimWindowSamples) return;

    const excess = this.queueLatencyLowSamples - this.prebufferSamples;
    this.resetQueueLatencyWindow();
    if (excess <= this.trimMarginSamples) return;

    // The low point bounds the queue from below, so the target's worth of
    // audio is still queued behind the excess to fade into.
    const fadeSamples = Math.min(this.trimFadeSamples, this.queuedSamples - excess);
    const skipped = this.readQueuedHead(this.trimFadeFrom, fadeSamples);
    let remaining = excess;
    while (remaining > 0 && this.queue.length > 0) {
      const oldest = this.queue[0];
      const usable = oldest.length - this.offset;
      if (usable <= remaining) {
        this.queue.shift();
        this.offset = 0;
        this.queuedSamples -= usable;
        remaining -= usable;
      } else {
        this.offset += remaining;
        this.queuedSamples -= remaining;
        remaining = 0;
      }
    }
    this.trimmedSamples += excess - remaining;
    if (this.recoveryFadeRemainingSamples > 0 || skipped === 0) {
      // Still leaving an earlier edge: keep converging from what was heard.
      this.beginRecoveryFade();
      return;
    }
    this.trimFadeTotalSamples = skipped;
    this.trimFadeRemainingSamples = skipped;
  }

  /** Copies up to `count` samples from the head of the queue without consuming them. */
  readQueuedHead(target, count) {
    let copied = 0;
    let offset = this.offset;
    for (let index = 0; index < this.queue.length && copied < count; index += 1) {
      const chunk = this.queue[index];
      const take = Math.min(count - copied, chunk.length - offset);
      target.set(chunk.subarray(offset, offset + take), copied);
      copied += take;
      offset = 0;
    }
    return copied;
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

  rememberOutput(output, count) {
    for (let index = 0; index < count; index += 1) {
      this.history[this.historyWrite] = output[index];
      this.historyWrite = (this.historyWrite + 1) % this.historySamples;
    }
    this.historyFilled = Math.min(this.historySamples, this.historyFilled + count);
  }

  /** Recent real output, oldest first. */
  unrolledHistory() {
    const length = this.historyFilled;
    const recent = new Float32Array(length);
    const start = (this.historyWrite - length + this.historySamples) % this.historySamples;
    for (let index = 0; index < length; index += 1) {
      recent[index] = this.history[(start + index) % this.historySamples];
    }
    return recent;
  }

  /**
   * The period of the last real output, or null when it has none worth
   * repeating: too little history, no energy, or no lag that correlates.
   * Runs once per underrun, never per render quantum.
   */
  estimateConcealmentPeriod() {
    if (this.historyFilled < this.historySamples) return null;
    const recent = this.unrolledHistory();
    let mean = 0;
    for (const sample of recent) mean += sample;
    mean /= recent.length;
    for (let index = 0; index < recent.length; index += 1) recent[index] -= mean;

    const window = Math.round((sampleRate * CONCEAL_WINDOW_MS) / 1000);
    const end = recent.length;
    const minLag = Math.max(2, Math.floor(sampleRate / CONCEAL_MIN_PERIOD_HZ));
    const maxLag = Math.min(Math.floor(sampleRate / CONCEAL_MAX_PERIOD_HZ), end - window);
    if (maxLag < minLag) return null;
    let segmentEnergy = 0;
    for (let index = end - window; index < end; index += 1) segmentEnergy += recent[index] ** 2;
    // Below about -80 dBFS RMS there is nothing to continue.
    if (segmentEnergy / window < 1e-8) return null;

    const correlationAt = (lag) => {
      let cross = 0;
      let energy = 0;
      for (let index = end - window; index < end; index += 1) {
        const lagged = recent[index - lag];
        cross += recent[index] * lagged;
        energy += lagged * lagged;
      }
      return energy > 0 ? cross / Math.sqrt(segmentEnergy * energy) : -1;
    };
    let bestLag = minLag;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag += 2) {
      const score = correlationAt(lag);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    for (let lag = Math.max(minLag, bestLag - 1); lag <= Math.min(maxLag, bestLag + 1); lag += 1) {
      const score = correlationAt(lag);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    return bestScore >= CONCEAL_MIN_CORRELATION ? bestLag : null;
  }

  /** Starts concealing an underrun; false leaves the edge to the silence fade. */
  beginConcealment() {
    const period = this.estimateConcealmentPeriod();
    if (period === null) return false;
    const recent = this.unrolledHistory();
    this.concealCycle = recent.slice(recent.length - period);
    this.concealPeriod = period;
    this.concealEmittedSamples = 0;
    this.silenceFadeRemainingSamples = 0;
    this.recoveryFadeRemainingSamples = 0;
    this.trimFadeRemainingSamples = 0;
    return true;
  }

  writeConcealment(output, start) {
    const fadeSamples = Math.max(1, this.concealMaxSamples - this.concealHoldSamples);
    for (let index = start; index < output.length && this.concealPeriod !== null; index += 1) {
      const emitted = this.concealEmittedSamples;
      if (emitted >= this.concealMaxSamples) {
        this.concealPeriod = null;
        break;
      }
      const gain = emitted < this.concealHoldSamples
        ? 1
        : Math.max(0, 1 - (emitted - this.concealHoldSamples + 1) / fadeSamples);
      output[index] = this.concealCycle[emitted % this.concealPeriod] * gain;
      this.concealEmittedSamples += 1;
      this.concealedSamples += 1;
    }
    this.lastOutputSample = output.length > 0 ? output[output.length - 1] : 0;
  }

  beginSilenceFade() {
    this.silenceFadeStartSample = this.lastOutputSample;
    this.silenceFadeRemainingSamples = this.outputGapFadeSamples;
    this.recoveryFadeRemainingSamples = 0;
    this.trimFadeRemainingSamples = 0;
  }

  writeSilenceFade(output, start) {
    const total = this.outputGapFadeSamples;
    let index = start;
    while (index < output.length && this.silenceFadeRemainingSamples > 0) {
      const progress = total - this.silenceFadeRemainingSamples;
      const weight = total <= 1 ? 0 : 1 - (progress / (total - 1));
      output[index] = this.silenceFadeStartSample * weight;
      this.silenceFadeRemainingSamples -= 1;
      index += 1;
    }
    this.lastOutputSample = output.length > 0 ? output[output.length - 1] : 0;
  }

  beginRecoveryFade() {
    this.recoveryFadeStartSample = this.lastOutputSample;
    this.recoveryFadeRemainingSamples = this.outputGapFadeSamples;
    this.silenceFadeRemainingSamples = 0;
    this.trimFadeRemainingSamples = 0;
  }

  writeQueuedSamples(output, written, chunk, sourceOffset, count) {
    if (this.recoveryFadeRemainingSamples <= 0 && this.trimFadeRemainingSamples <= 0) {
      output.set(chunk.subarray(sourceOffset, sourceOffset + count), written);
      return;
    }

    const total = this.outputGapFadeSamples;
    const trimTotal = this.trimFadeTotalSamples;
    for (let i = 0; i < count; i += 1) {
      const sample = chunk[sourceOffset + i];
      if (this.recoveryFadeRemainingSamples > 0) {
        const progress = total - this.recoveryFadeRemainingSamples;
        const weight = total <= 1 ? 1 : progress / (total - 1);
        output[written + i] = this.recoveryFadeStartSample * (1 - weight) + sample * weight;
        this.recoveryFadeRemainingSamples -= 1;
      } else if (this.trimFadeRemainingSamples > 0) {
        const progress = trimTotal - this.trimFadeRemainingSamples;
        const weight = (progress + 1) / (trimTotal + 1);
        output[written + i] = this.trimFadeFrom[progress] * (1 - weight) + sample * weight;
        this.trimFadeRemainingSamples -= 1;
      } else {
        output[written + i] = sample;
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);
    this.renderClockSamples += output.length;

    if (!this.playing) {
      if (this.pendingRecovery) this.recoveryWaitSamples += output.length;
      if (this.queuedSamples < this.prebufferSamples) {
        if (this.concealPeriod !== null) this.writeConcealment(output, 0);
        else if (this.silenceFadeRemainingSamples > 0) this.writeSilenceFade(output, 0);
        else this.lastOutputSample = 0;
        this.report(output.length);
        return true;
      }
      this.playing = true;
      this.concealPeriod = null;
      if (this.needsOutputRecoveryFade) {
        this.beginRecoveryFade();
        this.needsOutputRecoveryFade = false;
      }
      this.port.postMessage({ type: 'playing' });
    }

    let written = 0;
    while (written < output.length && this.queue.length > 0) {
      const chunk = this.queue[0];
      const available = chunk.length - this.offset;
      const count = Math.min(available, output.length - written);
      this.writeQueuedSamples(output, written, chunk, this.offset, count);

      written += count;
      this.offset += count;
      this.queuedSamples -= count;

      if (this.offset === chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    if (written < output.length) {
      if (written > 0) this.lastOutputSample = output[written - 1];
      this.rememberOutput(output, written);
      if (this.beginConcealment()) {
        this.writeConcealment(output, written);
      } else {
        this.beginSilenceFade();
        this.writeSilenceFade(output, written);
      }

      this.playing = false;
      this.underruns += 1;
      this.starvedSamples += output.length - written;
      this.stablePlaybackSamples = 0;
      this.pendingRecovery = true;
      this.recoveryWaitSamples = output.length - written;
      this.needsOutputRecoveryFade = true;
      this.resetQueueLatencyWindow();
      this.port.postMessage({ type: 'buffering' });
    } else {
      this.lastOutputSample = output[output.length - 1] ?? 0;
      this.rememberOutput(output, output.length);
      this.noteStablePlayback(output.length);
      this.observeQueueLatency(output.length);
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
      trimmedMs: (this.trimmedSamples / sampleRate) * 1000,
      starvedMs: (this.starvedSamples / sampleRate) * 1000,
      concealedMs: (this.concealedSamples / sampleRate) * 1000,
      playing: this.playing,
    });
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
