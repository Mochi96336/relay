const DEFAULT_INITIAL_PREBUFFER_MS = 100;
const DEFAULT_MIN_PREBUFFER_MS = 80;
const DEFAULT_MAX_PREBUFFER_MS = 250;
const DEFAULT_RECOVERY_STEP_MS = 50;
const DEFAULT_RECOVERY_WINDOW_MS = 1_000;
const DEFAULT_STABLE_STEP_MS = 10;
const DEFAULT_STABLE_WINDOW_MS = 30_000;
const DEFAULT_MAX_QUEUE_MS = 2_000;
const REPORT_INTERVAL_MS = 500;

// Listen needs two different behaviours from one small buffer policy:
// start quickly on a healthy network, but become conservative after a real
// jitter shortfall. A short underrun that receives audio again soon raises the
// next fill target; a long period with no PCM is treated as stream idle/link
// loss instead of something a sub-250 ms jitter buffer could repair. The target
// only falls after sustained clean playback. Changing it never stretches,
// pauses or skips audio already playing; it only changes future startup/rebuffer.
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
    // `prebufferMs` used to be one fixed target. Keep accepting it as the
    // adaptive ceiling so existing listeners can opt into the new policy
    // without a second coordinated client change.
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

    this.maxQueueSamples = Math.round(
      (sampleRate * (Number.isFinite(maxQueueMs) ? maxQueueMs : DEFAULT_MAX_QUEUE_MS)) / 1000,
    );
    // The ceiling must stay above the largest adaptive fill target or playback
    // could reach a state where it can never collect enough audio to restart.
    this.maxQueueSamples = Math.max(this.maxQueueSamples, this.maxPrebufferSamples * 2);
    this.reportEvery = Math.max(1, Math.round((sampleRate * REPORT_INTERVAL_MS) / (1000 * 128)));
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;
  }

  reset() {
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.playing = false;
    this.stablePlaybackSamples = 0;
    this.pendingRecovery = false;
    this.recoveryWaitSamples = 0;
    // Deliberately keep the learned prebuffer target. A reconnect or Mic mute
    // should not forget that this network already proved it needs more room.
  }

  push(samples) {
    if (samples.length === 0) return;

    if (this.pendingRecovery) {
      // Only short gaps are jitter evidence. If no PCM has arrived for longer
      // than the recovery window, this is more likely an intentional idle or a
      // link outage; a 250 ms buffer cannot mask it anyway, so do not ratchet
      // latency upward for the next healthy session.
      if (this.recoveryWaitSamples <= this.recoveryWindowSamples) {
        this.raisePrebuffer();
      }
      this.pendingRecovery = false;
      this.recoveryWaitSamples = 0;
    }

    this.queue.push(samples);
    this.queuedSamples += samples.length;

    // Trim from the front: the newest audio is the one that keeps output in
    // step with real time, so an overlong queue means latency, not content.
    while (this.queuedSamples > this.maxQueueSamples && this.queue.length > 1) {
      const oldest = this.queue[0];
      const usable = oldest.length - this.offset;
      this.queue.shift();
      this.offset = 0;
      this.queuedSamples -= usable;
      this.droppedSamples += usable;
    }
  }

  raisePrebuffer() {
    this.prebufferSamples = Math.min(
      this.maxPrebufferSamples,
      this.prebufferSamples + this.recoveryStepSamples,
    );
    this.stablePlaybackSamples = 0;
  }

  noteStablePlayback(samples) {
    if (this.prebufferSamples <= this.minPrebufferSamples) return;
    this.stablePlaybackSamples += samples;
    if (this.stablePlaybackSamples < this.stableWindowSamples) return;

    this.prebufferSamples = Math.max(
      this.minPrebufferSamples,
      this.prebufferSamples - this.stableStepSamples,
    );
    this.stablePlaybackSamples = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);

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
      underruns: this.underruns,
      droppedMs: (this.droppedSamples / sampleRate) * 1000,
      starvedMs: (this.starvedSamples / sampleRate) * 1000,
      playing: this.playing,
    });
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
