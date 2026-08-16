import type { MixHealth } from './audio-session.js';

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
  micAvailable: boolean;
  backingAvailable: boolean;
  timingMode: 'network-estimate' | 'acoustic-calibration';
  calibrationStale: boolean;
  alignmentClamped: boolean;
  robotRoute: boolean;
  robotDeltaFresh: boolean;
};

export type TakeQualityEvidence = {
  recordedSamples: number;
  recordedDurationMs: number;
  micGapMs: number;
  backingGapMs: number;
  micStarvedFrames: number;
  backingStarvedFrames: number;
  micStarvedMs: number;
  backingStarvedMs: number;
  clippedSamples: number;
  clippedMs: number;
  limitedSamples: number;
  limitedMs: number;
  unheadered: boolean;
  micUnavailableMs: number;
  backingUnavailableMs: number;
  networkEstimateMs: number;
  calibrationStaleMs: number;
  alignmentClampedMs: number;
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

function counterDelta(current: number, baseline: number) {
  return Math.max(0, current - baseline);
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
    'Microphone audio was unavailable while Relay was recording mixed output.',
  );
  addDurationIssue(
    issues,
    'backing-unavailable',
    evidence.backingUnavailableMs,
    'Backing audio was unavailable while Relay was recording mixed output.',
  );
  addDurationIssue(
    issues,
    'mic-pcm-gap',
    evidence.micGapMs,
    'The microphone transport left positioned PCM gaps during this Take.',
  );
  addDurationIssue(
    issues,
    'backing-pcm-gap',
    evidence.backingGapMs,
    'The backing transport left positioned PCM gaps during this Take.',
  );
  addDurationIssue(
    issues,
    'mic-starvation',
    evidence.micStarvedMs,
    'The mixer reached microphone positions that had not arrived yet.',
  );
  addDurationIssue(
    issues,
    'backing-starvation',
    evidence.backingStarvedMs,
    'The mixer reached backing positions that had not arrived yet.',
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

  if (evidence.unheadered) {
    issues.push({
      code: 'unheadered-pcm',
      severity: 'warning',
      value: true,
      unit: 'boolean',
      message: 'At least one source used legacy PCM without timeline positioning metadata during this Take.',
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
 * Binds cumulative mixer counters and per-recorded-frame state to exactly one
 * Take. Mixer health is epoch-scoped, so a baseline is mandatory: without it a
 * Take started halfway through a live session would inherit earlier dropouts and
 * clipping that are not present in its WAV artifact.
 */
export class TakeQualityTracker {
  private readonly baseline: MixHealth;
  private lastHealth: MixHealth;
  private recordedSamples = 0;
  private micUnavailableSamples = 0;
  private backingUnavailableSamples = 0;
  private networkEstimateSamples = 0;
  private calibrationStaleSamples = 0;
  private alignmentClampedSamples = 0;
  private robotDeltaMissingSamples = 0;
  private unheaderedObserved = false;
  private readonly events = emptyEvents();

  constructor(private readonly options: {
    sampleRate: number;
    frameMs: number;
    baselineHealth: MixHealth;
  }) {
    this.baseline = { ...options.baselineHealth };
    this.lastHealth = { ...options.baselineHealth };
  }

  observeFrame(sampleCount: number, state: TakeQualityFrameState, health: MixHealth) {
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) return;
    this.recordedSamples += sampleCount;
    if (!state.micAvailable) this.micUnavailableSamples += sampleCount;
    if (!state.backingAvailable) this.backingUnavailableSamples += sampleCount;
    if (state.timingMode === 'network-estimate') this.networkEstimateSamples += sampleCount;
    if (state.calibrationStale) this.calibrationStaleSamples += sampleCount;
    if (state.alignmentClamped) this.alignmentClampedSamples += sampleCount;
    if (state.robotRoute && !state.robotDeltaFresh) this.robotDeltaMissingSamples += sampleCount;
    // `unheadered` is an epoch-level latch, not a counter. Attribute it only
    // when the latch was clear at Start and becomes set while this Take is
    // actually accepting mixed frames; a pre-existing legacy warning belongs
    // to the earlier epoch history, not automatically to this WAV.
    if (!this.baseline.unheadered && health.unheadered) this.unheaderedObserved = true;
    this.lastHealth = { ...health };
  }

  noteEvent(kind: TakeQualityEventKind) {
    this.events[kind] += 1;
  }

  assessment() {
    const toMs = (samples: number) => Math.round((samples / this.options.sampleRate) * 1000);
    const micStarvedFrames = counterDelta(
      this.lastHealth.micStarvedFrames,
      this.baseline.micStarvedFrames,
    );
    const backingStarvedFrames = counterDelta(
      this.lastHealth.backingStarvedFrames,
      this.baseline.backingStarvedFrames,
    );
    const clippedSamples = counterDelta(this.lastHealth.clippedSamples, this.baseline.clippedSamples);
    const limitedSamples = counterDelta(this.lastHealth.limitedSamples, this.baseline.limitedSamples);

    return assessTakeQuality({
      recordedSamples: this.recordedSamples,
      recordedDurationMs: toMs(this.recordedSamples),
      micGapMs: counterDelta(this.lastHealth.micGapMs, this.baseline.micGapMs),
      backingGapMs: counterDelta(this.lastHealth.backingGapMs, this.baseline.backingGapMs),
      micStarvedFrames,
      backingStarvedFrames,
      micStarvedMs: Math.round(micStarvedFrames * this.options.frameMs),
      backingStarvedMs: Math.round(backingStarvedFrames * this.options.frameMs),
      clippedSamples,
      clippedMs: toMs(clippedSamples),
      limitedSamples,
      limitedMs: toMs(limitedSamples),
      unheadered: this.unheaderedObserved,
      micUnavailableMs: toMs(this.micUnavailableSamples),
      backingUnavailableMs: toMs(this.backingUnavailableSamples),
      networkEstimateMs: toMs(this.networkEstimateSamples),
      calibrationStaleMs: toMs(this.calibrationStaleSamples),
      alignmentClampedMs: toMs(this.alignmentClampedSamples),
      robotDeltaMissingMs: toMs(this.robotDeltaMissingSamples),
      events: { ...this.events },
    });
  }
}
