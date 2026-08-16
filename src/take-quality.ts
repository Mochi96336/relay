import type { MixFrameEvidence } from './audio-session.js';

export const TAKE_QUALITY_POLICY_VERSION = 'take-quality-v1' as const;

export type TakeQualityVerdict = 'clean' | 'review' | 'degraded';
export type TakeQualitySeverity = 'warning' | 'critical';

export type TakeQualityEventKind =
  | 'mic-transport-disconnected'
  | 'mic-transport-connected'
  | 'mic-capture-restarted'
  | 'backing-transport-disconnected'
  | 'backing-transport-connected'
  | 'backing-transport-replaced'
  | 'backing-capture-restarted'
  | 'robot-source-disconnected'
  | 'robot-source-connected'
  | 'robot-source-replaced'
  | 'mic-owner-changed';

export type TakeQualityEventCounts = Record<TakeQualityEventKind, number>;

export type TakeQualityFrameState = {
  timingMode: 'network-estimate' | 'acoustic-calibration';
  calibrationStale: boolean;
  alignmentClamped: boolean;
  robotRoute: boolean;
  robotDeltaFresh: boolean;
};

/**
 * Take-level evidence keeps exact sample counts as the source of truth and ms
 * values as a derived convenience for diagnostics/UI. Nothing sub-millisecond
 * is rounded away before the versioned policy sees it.
 */
export type TakeQualityEvidence = {
  sampleRate: number;
  recordedSamples: number;
  recordedDurationMs: number;
  micGapSamples: number;
  micGapMs: number;
  backingGapSamples: number;
  backingGapMs: number;
  micStarvedFrames: number;
  backingStarvedFrames: number;
  micStarvedSamples: number;
  backingStarvedSamples: number;
  micStarvedMs: number;
  backingStarvedMs: number;
  clippedSamples: number;
  clippedMs: number;
  limitedSamples: number;
  limitedMs: number;
  unheaderedSamples: number;
  unheadered: boolean;
  micUnavailableSamples: number;
  micUnavailableMs: number;
  backingUnavailableSamples: number;
  backingUnavailableMs: number;
  networkEstimateSamples: number;
  networkEstimateMs: number;
  calibrationStaleSamples: number;
  calibrationStaleMs: number;
  alignmentClampedSamples: number;
  alignmentClampedMs: number;
  robotDeltaMissingSamples: number;
  robotDeltaMissingMs: number;
  events: TakeQualityEventCounts;
};

export type TakeQualityIssueCode =
  | 'mic-unavailable'
  | 'backing-unavailable'
  | 'mic-pcm-gap'
  | 'backing-pcm-gap'
  | 'mic-starvation'
  | 'backing-starvation'
  | 'output-clipping'
  | 'unheadered-pcm'
  | 'timing-fallback'
  | 'calibration-stale'
  | 'alignment-clamped'
  | 'robot-delta-missing'
  | 'transport-instability';

export type TakeQualityIssue = {
  code: TakeQualityIssueCode;
  severity: TakeQualitySeverity;
  value: number | boolean;
  unit: 'ms' | 'samples' | 'events' | 'boolean';
  message: string;
};

export type TakeQualityAssessment = {
  policyVersion: typeof TAKE_QUALITY_POLICY_VERSION;
  verdict: TakeQualityVerdict;
  evidence: TakeQualityEvidence;
  issues: TakeQualityIssue[];
};

const DEGRADED_DURATION_MS = 250;
const DEGRADED_CLIPPING_MS = 20;

function emptyEvents(): TakeQualityEventCounts {
  return {
    'mic-transport-disconnected': 0,
    'mic-transport-connected': 0,
    'mic-capture-restarted': 0,
    'backing-transport-disconnected': 0,
    'backing-transport-connected': 0,
    'backing-transport-replaced': 0,
    'backing-capture-restarted': 0,
    'robot-source-disconnected': 0,
    'robot-source-connected': 0,
    'robot-source-replaced': 0,
    'mic-owner-changed': 0,
  };
}

function durationSeverity(durationMs: number, criticalAtMs = DEGRADED_DURATION_MS): TakeQualitySeverity {
  return durationMs >= criticalAtMs ? 'critical' : 'warning';
}

function addDurationIssue(
  issues: TakeQualityIssue[],
  code: TakeQualityIssueCode,
  durationMs: number,
  message: string,
  criticalAtMs = DEGRADED_DURATION_MS,
) {
  if (durationMs <= 0) return;
  issues.push({
    code,
    severity: durationSeverity(durationMs, criticalAtMs),
    value: durationMs,
    unit: 'ms',
    message,
  });
}

export function assessTakeQuality(evidence: TakeQualityEvidence): TakeQualityAssessment {
  const issues: TakeQualityIssue[] = [];

  addDurationIssue(
    issues,
    'mic-unavailable',
    evidence.micUnavailableMs,
    'Microphone audio was unavailable in the mixed samples recorded by this Take.',
  );
  addDurationIssue(
    issues,
    'backing-unavailable',
    evidence.backingUnavailableMs,
    'Backing audio was unavailable in the mixed samples recorded by this Take.',
  );
  addDurationIssue(
    issues,
    'mic-pcm-gap',
    evidence.micGapMs,
    'The recorded microphone range contained positioned PCM gaps.',
  );
  addDurationIssue(
    issues,
    'backing-pcm-gap',
    evidence.backingGapMs,
    'The recorded backing range contained positioned PCM gaps.',
  );
  addDurationIssue(
    issues,
    'mic-starvation',
    evidence.micStarvedMs,
    'The mixer recorded microphone samples beyond the live source frontier.',
  );
  addDurationIssue(
    issues,
    'backing-starvation',
    evidence.backingStarvedMs,
    'The mixer recorded backing samples beyond the live source frontier.',
  );

  if (evidence.clippedSamples > 0) {
    issues.push({
      code: 'output-clipping',
      severity: evidence.clippedMs >= DEGRADED_CLIPPING_MS ? 'critical' : 'warning',
      value: evidence.clippedSamples,
      unit: 'samples',
      message: 'The final summing stage had to clamp mixed samples.',
    });
  }

  if (evidence.unheaderedSamples > 0) {
    issues.push({
      code: 'unheadered-pcm',
      severity: 'warning',
      value: evidence.unheaderedSamples,
      unit: 'samples',
      message: 'Recorded source samples came from legacy PCM without timeline positioning metadata.',
    });
  }

  if (evidence.networkEstimateMs > 0) {
    issues.push({
      code: 'timing-fallback',
      severity: 'warning',
      value: evidence.networkEstimateMs,
      unit: 'ms',
      message: 'Part of the Take used network-estimate timing instead of an applicable acoustic calibration.',
    });
  }

  if (evidence.calibrationStaleMs > 0) {
    issues.push({
      code: 'calibration-stale',
      severity: 'warning',
      value: evidence.calibrationStaleMs,
      unit: 'ms',
      message: 'A stored calibration no longer described the active capture arrangement during part of the Take.',
    });
  }

  addDurationIssue(
    issues,
    'alignment-clamped',
    evidence.alignmentClampedMs,
    'The requested microphone timing correction exceeded the mix buffers and had to be clamped.',
  );

  if (evidence.robotDeltaMissingMs > 0) {
    issues.push({
      code: 'robot-delta-missing',
      severity: 'warning',
      value: evidence.robotDeltaMissingMs,
      unit: 'ms',
      message: 'Robot playback was active without a fresh player delta for part of the Take.',
    });
  }

  const instabilityEvents =
    evidence.events['mic-transport-disconnected']
    + evidence.events['mic-capture-restarted']
    + evidence.events['backing-transport-disconnected']
    + evidence.events['backing-transport-replaced']
    + evidence.events['backing-capture-restarted']
    + evidence.events['robot-source-disconnected']
    + evidence.events['robot-source-replaced'];
  if (instabilityEvents > 0) {
    issues.push({
      code: 'transport-instability',
      severity: 'warning',
      value: instabilityEvents,
      unit: 'events',
      message: 'One or more source transports changed or restarted while the Take was recording.',
    });
  }

  const verdict: TakeQualityVerdict = issues.some((issue) => issue.severity === 'critical')
    ? 'degraded'
    : issues.length > 0
      ? 'review'
      : 'clean';

  return {
    policyVersion: TAKE_QUALITY_POLICY_VERSION,
    verdict,
    evidence,
    issues,
  };
}

/**
 * Binds exact mixer-frame facts and higher-layer timing/transport context to one
 * Take. AudioSession emits the evidence beside the PCM frame it describes, so
 * the tracker never has to infer WAV damage from epoch counters or transport
 * liveness.
 */
export class TakeQualityTracker {
  private recordedSamples = 0;
  private micGapSamples = 0;
  private backingGapSamples = 0;
  private micStarvedSamples = 0;
  private backingStarvedSamples = 0;
  private micStarvedFrames = 0;
  private backingStarvedFrames = 0;
  private clippedSamples = 0;
  private limitedSamples = 0;
  private unheaderedSamples = 0;
  private micUnavailableSamples = 0;
  private backingUnavailableSamples = 0;
  private networkEstimateSamples = 0;
  private calibrationStaleSamples = 0;
  private alignmentClampedSamples = 0;
  private robotDeltaMissingSamples = 0;
  private readonly events = emptyEvents();

  constructor(private readonly options: {
    sampleRate: number;
    /** False for an intentional voice-only Take. */
    backingExpected?: boolean;
    /** False when there is no Song for Voice to align against. */
    timingExpected?: boolean;
  }) {}

  observeFrame(sampleCount: number, state: TakeQualityFrameState, audio: MixFrameEvidence) {
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) return;

    this.recordedSamples += sampleCount;
    this.micGapSamples += audio.micGapSamples;
    this.micStarvedSamples += audio.micStarvedSamples;
    if (audio.micStarvedSamples > 0) this.micStarvedFrames += 1;
    this.micUnavailableSamples += audio.micUnavailableSamples;

    if (this.options.backingExpected !== false) {
      this.backingGapSamples += audio.backingGapSamples;
      this.backingStarvedSamples += audio.backingStarvedSamples;
      if (audio.backingStarvedSamples > 0) this.backingStarvedFrames += 1;
      this.backingUnavailableSamples += audio.backingUnavailableSamples;
    }

    this.clippedSamples += audio.clippedSamples;
    this.limitedSamples += audio.limitedSamples;
    this.unheaderedSamples += audio.unheaderedSamples;

    if (this.options.timingExpected !== false) {
      if (state.timingMode === 'network-estimate') this.networkEstimateSamples += sampleCount;
      if (state.calibrationStale) this.calibrationStaleSamples += sampleCount;
      if (state.alignmentClamped) this.alignmentClampedSamples += sampleCount;
      if (state.robotRoute && !state.robotDeltaFresh) this.robotDeltaMissingSamples += sampleCount;
    }
  }

  noteEvent(kind: TakeQualityEventKind) {
    if (
      this.options.backingExpected === false
      && (kind.startsWith('backing-') || kind.startsWith('robot-'))
    ) return;
    this.events[kind] += 1;
  }

  assessment() {
    const sampleRate = this.options.sampleRate;
    const toMs = (samples: number) => (samples / sampleRate) * 1000;

    return assessTakeQuality({
      sampleRate,
      recordedSamples: this.recordedSamples,
      recordedDurationMs: toMs(this.recordedSamples),
      micGapSamples: this.micGapSamples,
      micGapMs: toMs(this.micGapSamples),
      backingGapSamples: this.backingGapSamples,
      backingGapMs: toMs(this.backingGapSamples),
      micStarvedFrames: this.micStarvedFrames,
      backingStarvedFrames: this.backingStarvedFrames,
      micStarvedSamples: this.micStarvedSamples,
      backingStarvedSamples: this.backingStarvedSamples,
      micStarvedMs: toMs(this.micStarvedSamples),
      backingStarvedMs: toMs(this.backingStarvedSamples),
      clippedSamples: this.clippedSamples,
      clippedMs: toMs(this.clippedSamples),
      limitedSamples: this.limitedSamples,
      limitedMs: toMs(this.limitedSamples),
      unheaderedSamples: this.unheaderedSamples,
      unheadered: this.unheaderedSamples > 0,
      micUnavailableSamples: this.micUnavailableSamples,
      micUnavailableMs: toMs(this.micUnavailableSamples),
      backingUnavailableSamples: this.backingUnavailableSamples,
      backingUnavailableMs: toMs(this.backingUnavailableSamples),
      networkEstimateSamples: this.networkEstimateSamples,
      networkEstimateMs: toMs(this.networkEstimateSamples),
      calibrationStaleSamples: this.calibrationStaleSamples,
      calibrationStaleMs: toMs(this.calibrationStaleSamples),
      alignmentClampedSamples: this.alignmentClampedSamples,
      alignmentClampedMs: toMs(this.alignmentClampedSamples),
      robotDeltaMissingSamples: this.robotDeltaMissingSamples,
      robotDeltaMissingMs: toMs(this.robotDeltaMissingSamples),
      events: { ...this.events },
    });
  }
}
