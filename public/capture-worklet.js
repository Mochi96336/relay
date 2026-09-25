const RENDER_QUANTUM = 128;
const SILENCE_DBFS = -120;
// Narrow enough that an unclipped voice peak normally touches it for at most
// one sample. A flat-topped capture instead produces a run of rail samples.
const INPUT_RAIL_THRESHOLD = 0x7fff / 0x8000;
// Gap padding is synthetic continuity audio, not raw microphone evidence.
// Keep it one quantization step below the raw-input rail so downstream PCM
// inspection cannot complete a flat-top run that never existed at the input.
const SYNTHETIC_INPUT_GAP_MAX_MAGNITUDE = (0x7fff - 1) / 0x8000;
// Int16 codes Relay reads as the raw-input rail (AudioSession
// observeMicInputClippingFrame): >= +32766 or <= -32767.
const PCM16_RAIL_POSITIVE = 0x7fff - 1;
const PCM16_RAIL_NEGATIVE = -0x7fff;
const INPUT_GAP_DECLICK_MS = 2;
const INPUT_GAP_REPORT_REFERENCE_RATE = 48_000;
const INPUT_GAP_REPORT_REFERENCE_QUANTA = 400;
// An unprocessed microphone's noise floor always moves at least one LSB. A
// present input channel that stays exactly zero this long is not a quiet room:
// it is an interrupted or silenced capture (seen after OS audio-session
// interruptions) still rendering digital silence. It is reported through the
// same input-gap contract as a missing channel, so Relay stops calling the
// Mic live and the page may rebuild the capture.
const DIGITAL_SILENCE_REPORT_MS = 2_000;
const VISUAL_ANALYSIS_PLACEHOLDER = Object.freeze({
  spectrumBands: Object.freeze([0, 0, 0, 0, 0]),
  f0Hz: null,
  pitchConfidence: 0,
});

function amplitudeToDbfs(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : SILENCE_DBFS;
}

/**
 * Float -> Int16 to the nearest step. Storing into Int16Array truncates toward
 * zero instead, which makes every sample up to a whole step smaller, always
 * toward silence: an error that follows the signal (distortion rather than
 * noise), which Relay's default +24 dB Mic gain then lifts with the voice.
 *
 * Rounding must not move a sample onto the codes Relay reads as raw-input
 * clipping, though. Only a sample that really reached the rail threshold may
 * land there, exactly as truncation guaranteed; everything below stays one
 * step short of it.
 */
function toPcm16(sample) {
  if (sample < 0) {
    const value = Math.round(sample * 0x8000);
    return sample > -INPUT_RAIL_THRESHOLD ? Math.max(PCM16_RAIL_NEGATIVE + 1, value) : value;
  }
  const value = Math.round(sample * 0x7fff);
  return sample < INPUT_RAIL_THRESHOLD ? Math.min(PCM16_RAIL_POSITIVE - 1, value) : value;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.max(128, Math.round(sampleRate * 0.02));
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.started = false;
    this.silenceQuanta = 0;
    this.activeGapQuanta = 0;
    this.reportedActiveGapQuanta = 0;
    // Preserve the existing ~1.067 s 48 kHz hysteresis in wall-clock time.
    // A fixed render-quantum count would diagnose the same physical outage
    // roughly twice as fast at 96 kHz as at 48 kHz.
    this.inputGapReportQuanta = Math.max(
      1,
      Math.round(
        (INPUT_GAP_REPORT_REFERENCE_QUANTA * sampleRate)
          / INPUT_GAP_REPORT_REFERENCE_RATE,
      ),
    );
    this.levelPeak = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;
    // Capture-lifetime evidence, not a one-frame alarm. A 1 Hz health snapshot
    // must not miss a short clipped syllable that happened between reports.
    this.railSamples = 0;
    this.currentRailRunSamples = 0;
    this.maxConsecutiveRailSamples = 0;
    // Per-level-window evidence. Unlike the capture-lifetime maximum above,
    // this resets after each 20 ms report so the page can aggregate only the
    // interval covered by its next health snapshot.
    this.windowMaxConsecutiveRailSamples = 0;
    this.inputGapFadeSamples = Math.max(1, Math.round(sampleRate * (INPUT_GAP_DECLICK_MS / 1000)));
    this.gapFadeRemainingSamples = 0;
    this.gapFadeStartSample = 0;
    this.recoveryFadeRemainingSamples = 0;
    this.recoveryFadeStartSample = 0;
    this.lastOutputSample = 0;
    this.chunkStartedAtContextTime = null;
    this.digitalSilenceReportSamples = Math.max(
      RENDER_QUANTUM,
      Math.round((DIGITAL_SILENCE_REPORT_MS * sampleRate) / 1000),
    );
    this.digitalSilenceRunSamples = 0;
    this.digitalSilenceActive = false;

    // Rollout compatibility is deliberately asymmetric: a newly deployed
    // worklet can be loaded by a page whose old app.js has been open across the
    // deploy. That app only understands raw ArrayBuffer PCM. Stay on the legacy
    // wire shape until a new app explicitly opts into the timestamp envelope.
    this.pcmEnvelopeEnabled = false;
    this.port.onmessage = (event) => {
      if (
        event.data?.type === 'capture-protocol'
        && event.data.pcmEnvelope === true
      ) {
        this.pcmEnvelopeEnabled = true;
      }
    };
  }

  reportInputGap(recovered) {
    const unreported = this.activeGapQuanta - this.reportedActiveGapQuanta;
    if (unreported <= 0) return;
    this.reportedActiveGapQuanta = this.activeGapQuanta;
    this.port.postMessage({
      type: 'input-gap',
      quanta: unreported,
      samples: unreported * RENDER_QUANTUM,
      totalQuanta: this.silenceQuanta,
      recovered,
    });
  }

  writeInputGap(count) {
    let remaining = count;
    let written = 0;
    while (remaining > 0) {
      if (this.offset === 0) {
        this.chunkStartedAtContextTime = (
          typeof currentTime === 'number' && Number.isFinite(currentTime)
            ? currentTime + (written / sampleRate)
            : null
        );
      }

      const room = this.chunkSize - this.offset;
      const step = Math.min(room, remaining);
      for (let i = 0; i < step; i += 1) {
        let outputSample = 0;
        if (this.gapFadeRemainingSamples > 0) {
          const total = this.inputGapFadeSamples;
          const weight = total <= 1
            ? 0
            : (this.gapFadeRemainingSamples - 1) / (total - 1);
          outputSample = this.gapFadeStartSample * weight;
          this.gapFadeRemainingSamples -= 1;
        }
        outputSample = Math.max(
          -SYNTHETIC_INPUT_GAP_MAX_MAGNITUDE,
          Math.min(SYNTHETIC_INPUT_GAP_MAX_MAGNITUDE, outputSample),
        );
        this.chunk[this.offset + i] = toPcm16(outputSample);
        this.lastOutputSample = outputSample;
      }

      this.offset += step;
      // Input-gap samples remain raw-silence evidence for the meter even though
      // the emitted PCM edge gets a tiny synthetic taper to suppress a click.
      this.levelSampleCount += step;
      this.currentRailRunSamples = 0;
      remaining -= step;
      written += step;
      this.flushIfFull();
    }
  }

  flushIfFull() {
    if (this.offset !== this.chunkSize) return;
    const rms = this.levelSampleCount > 0
      ? Math.sqrt(this.levelSquareSum / this.levelSampleCount)
      : 0;
    const peakDbfs = amplitudeToDbfs(this.levelPeak);
    const rmsDbfs = amplitudeToDbfs(rms);
    const samples = this.levelSampleCount;

    // PCM is the only realtime payload this AudioWorklet owns. Spectrum and
    // pitch are intentionally analysed in a dedicated Worker after the PCM has
    // reached the page, so visual DSP can never consume an audio render deadline.
    const buffer = this.chunk.buffer;
    const pcmMessage = this.pcmEnvelopeEnabled
      ? {
          type: 'pcm',
          buffer,
          // Timestamp the oldest sample in this chunk, not the flush point.
          // Otherwise a 20 ms chunk can be almost 20 ms older than its reported
          // age, quietly widening the 200 ms realtime backlog budget.
          capturedAtContextTime: this.chunkStartedAtContextTime,
        }
      : buffer;
    this.port.postMessage(pcmMessage, [buffer]);
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.chunkStartedAtContextTime = null;
    this.levelPeak = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;

    // Keep the old message shape for a cached pre-worker app.js during rolling
    // deploys. New pages replace these neutral fields with dedicated-Worker
    // analysis; old pages still retain a working local level meter.
    this.port.postMessage({
      type: 'input-level',
      peakDbfs,
      rmsDbfs,
      spectrumBands: VISUAL_ANALYSIS_PLACEHOLDER.spectrumBands,
      f0Hz: VISUAL_ANALYSIS_PLACEHOLDER.f0Hz,
      pitchConfidence: VISUAL_ANALYSIS_PLACEHOLDER.pitchConfidence,
      samples,
      railSamples: this.railSamples,
      maxConsecutiveRailSamples: this.maxConsecutiveRailSamples,
      windowMaxConsecutiveRailSamples: this.windowMaxConsecutiveRailSamples,
    });
    this.windowMaxConsecutiveRailSamples = 0;
  }

  /**
   * Digital-silence edges share the input-gap message so every consumer of
   * source authority already understands them. They carry no padded samples:
   * the zeros were real rendered PCM and already travel on the timeline.
   */
  reportDigitalSilence(recovered) {
    this.port.postMessage({
      type: 'input-gap',
      quanta: 0,
      samples: 0,
      totalQuanta: this.silenceQuanta,
      recovered,
      reason: 'digital-silence',
    });
  }

  observeDigitalSilence(input) {
    let nonZero = false;
    for (let i = 0; i < input.length; i += 1) {
      if (input[i] !== 0) {
        nonZero = true;
        break;
      }
    }
    if (nonZero) {
      this.digitalSilenceRunSamples = 0;
      if (this.digitalSilenceActive) {
        this.digitalSilenceActive = false;
        this.reportDigitalSilence(true);
      }
      return;
    }
    this.digitalSilenceRunSamples += input.length;
    if (
      !this.digitalSilenceActive
      && this.digitalSilenceRunSamples >= this.digitalSilenceReportSamples
    ) {
      this.digitalSilenceActive = true;
      this.reportDigitalSilence(false);
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];

    // Everything downstream aligns purely by sample count, so a gap here shifts
    // the whole microphone timeline forward for good. Emit silence for the
    // missing render quantum instead of skipping it.
    if (!input) {
      // A missing channel is its own, already-reported source failure.
      this.digitalSilenceRunSamples = 0;
      if (this.started) {
        this.silenceQuanta += 1;
        this.activeGapQuanta += 1;
        if (this.activeGapQuanta === 1) {
          this.gapFadeStartSample = this.lastOutputSample;
          this.gapFadeRemainingSamples = this.inputGapFadeSamples;
          this.recoveryFadeRemainingSamples = 0;
        }
        this.writeInputGap(RENDER_QUANTUM);
        if (
          this.activeGapQuanta - this.reportedActiveGapQuanta
            >= this.inputGapReportQuanta
        ) {
          this.reportInputGap(false);
        }
      }
      return true;
    }

    if (this.activeGapQuanta > 0) {
      this.reportInputGap(true);
      this.activeGapQuanta = 0;
      this.reportedActiveGapQuanta = 0;
      this.recoveryFadeStartSample = this.lastOutputSample;
      this.recoveryFadeRemainingSamples = this.inputGapFadeSamples;
    }
    this.started = true;
    this.observeDigitalSilence(input);
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      if (this.offset === 0) {
        this.chunkStartedAtContextTime = (
          typeof currentTime === 'number' && Number.isFinite(currentTime)
            ? currentTime + (sourceOffset / sampleRate)
            : null
        );
      }
      const remaining = this.chunkSize - this.offset;
      const count = Math.min(remaining, input.length - sourceOffset);

      for (let i = 0; i < count; i += 1) {
        const rawSample = input[sourceOffset + i];
        // WebAudio normally supplies finite Float32 PCM, but one non-finite
        // value must not poison the meter or the de-click state for every
        // later sample. Preserve capture time and replace only that invalid
        // sample with silence.
        const sample = Number.isFinite(rawSample)
          ? Math.max(-1, Math.min(1, rawSample))
          : 0;
        const magnitude = Math.abs(sample);
        this.levelPeak = Math.max(this.levelPeak, magnitude);
        this.levelSquareSum += sample * sample;
        this.levelSampleCount += 1;

        if (Math.abs(rawSample) >= INPUT_RAIL_THRESHOLD) {
          this.railSamples += 1;
          this.currentRailRunSamples += 1;
          this.maxConsecutiveRailSamples = Math.max(
            this.maxConsecutiveRailSamples,
            this.currentRailRunSamples,
          );
          this.windowMaxConsecutiveRailSamples = Math.max(
            this.windowMaxConsecutiveRailSamples,
            this.currentRailRunSamples,
          );
        } else {
          this.currentRailRunSamples = 0;
        }

        let outputSample = sample;
        if (this.recoveryFadeRemainingSamples > 0) {
          const total = this.inputGapFadeSamples;
          const progress = total - this.recoveryFadeRemainingSamples;
          const weight = total <= 1 ? 1 : progress / (total - 1);
          outputSample = this.recoveryFadeStartSample * (1 - weight) + sample * weight;
          this.recoveryFadeRemainingSamples -= 1;
        }

        this.chunk[this.offset + i] = toPcm16(outputSample);
        this.lastOutputSample = outputSample;
      }

      this.offset += count;
      sourceOffset += count;
      this.flushIfFull();
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
