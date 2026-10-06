import type { AudioSession } from './audio-session.js';
import type { CalibrationSession } from './calibration-session.js';
import type { ContentCalibrationValidator } from './content-calibration-validator.js';
import type { MicAudibilityMonitor, MicAudibilityResult } from './mic-audibility-monitor.js';
import type { MicClockDriftEstimator } from './mic-clock-drift-estimator.js';
import type { MicLevelMonitor } from './mic-level-monitor.js';
import type { MicRuntime } from './mic-runtime.js';
import type { PcmFrame } from './pcm-frame.js';
import type { createRelayMicCaptureRestartCoordinator } from './relay-mic-capture-restart-coordinator.js';
import type { createMonitorSocketTransport } from './relay-socket-server.js';
import type { RobotContentTransitionRuntime } from './robot-content-transition-runtime.js';
import type { TakeController } from './take-controller.js';
import type { TakeQualityFrameState } from './take-quality.js';

export type RelayMixPumpDependencies = {
  now(): number;
  readonly mix: Pick<AudioSession,
    'active' | 'liveMicHeadroomMs' | 'micGainDb' | 'ingestMic' | 'setMicClockTrimPpm' | 'drain'>;
  readonly mic: Pick<MicRuntime, 'audioTransport' | 'sampleRate' | 'serviceRetransmits' | 'flush' | 'noteFrame'>;
  readonly audibility: Pick<MicAudibilityMonitor, 'observeReceived' | 'observeFrame'>;
  readonly level: Pick<MicLevelMonitor, 'observeReceived' | 'observeFrame' | 'reset'>;
  readonly drift: Pick<MicClockDriftEstimator, 'observe' | 'estimate'>;
  readonly calibration: Pick<CalibrationSession, 'collecting' | 'primeMic' | 'observeMic'>;
  readonly validator: Pick<ContentCalibrationValidator, 'observeMic'>;
  readonly transition: Pick<RobotContentTransitionRuntime, 'noteMicProgress'>;
  readonly restart: Pick<ReturnType<typeof createRelayMicCaptureRestartCoordinator>, 'restart'>;
  readonly take: Pick<TakeController, 'append'>;
  readonly monitor: Pick<ReturnType<typeof createMonitorSocketTransport>, 'broadcast'>;
  readonly effects: {
    startLiveSource(): void;
    resetAudibility(): void;
    fallbackPrimingActive(): boolean;
    quality(nowMs: number): TakeQualityFrameState;
    micPlayable(nowMs: number): boolean;
    roomSongPlaying(nowMs: number): boolean;
    reportAudibility(result: MicAudibilityResult, nowMs: number): void;
    reportLevel(reason: 'window'): void;
    reportTimelineFolds(): void;
  };
};

export type RelayMixPumpScheduler = {
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
};

/** Synchronous media effect ordering; each domain owner retains its authority. */
export function createRelayMixPump(
  dependencies: RelayMixPumpDependencies,
  scheduler: RelayMixPumpScheduler = { setInterval, clearInterval },
) {
  let timer: ReturnType<typeof setInterval> | null = null;

  function ingest(frame: PcmFrame) {
    // Physical media may outlive control. Admission already occurred at the
    // publisher or media-ticket boundary; do not introduce a socket guard here.
    if (!dependencies.mic.audioTransport || dependencies.mic.sampleRate === null) return;
    if (!dependencies.mix.active) dependencies.effects.startLiveSource();

    const nowMs = dependencies.now();
    const { samples, start, captureRestarted } = dependencies.mix.ingestMic(
      frame, dependencies.mic.sampleRate, nowMs,
    );
    if (samples.length > 0) dependencies.mic.noteFrame(nowMs, frame);
    dependencies.audibility.observeReceived(samples);
    dependencies.level.observeReceived(samples);
    if (
      frame.firstSampleIndex !== null
      && frame.generation !== null
      && dependencies.drift.observe(
        frame.generation,
        dependencies.mic.sampleRate,
        frame.firstSampleIndex + frame.pcm.byteLength / 2,
        nowMs,
      )
    ) {
      dependencies.mix.setMicClockTrimPpm(dependencies.drift.estimate()?.ppm ?? null);
    }

    if (captureRestarted) {
      dependencies.effects.resetAudibility();
      dependencies.level.reset();
      dependencies.restart.restart({ calibrationCollecting: dependencies.calibration.collecting });
    }
    if (dependencies.effects.fallbackPrimingActive()) dependencies.calibration.primeMic(samples, start);
    dependencies.calibration.observeMic(samples, start);
    dependencies.validator.observeMic(samples, start);
    dependencies.transition.noteMicProgress();
  }

  function deliver(packets: PcmFrame[]) {
    for (const packet of packets) ingest(packet);
  }

  function tick() {
    if (dependencies.mic.audioTransport) {
      const nowMs = dependencies.now();
      dependencies.mic.serviceRetransmits(nowMs, dependencies.mix.liveMicHeadroomMs);
      deliver(dependencies.mic.flush(nowMs));
    }

    // Drain still samples its own clock and owns its default maxFrames. This
    // callback is synchronous: Take and monitor see the same frame/position.
    dependencies.mix.drain((frame, evidence, position) => {
      const nowMs = dependencies.now();
      dependencies.take.append(frame, dependencies.effects.quality(nowMs), evidence, position);
      dependencies.monitor.broadcast(frame, true, position);
      const audibility = dependencies.audibility.observeFrame({
        micLive: dependencies.effects.micPlayable(nowMs),
        frameSamples: frame.byteLength / 2,
        micGapSamples: evidence.micGapSamples,
        micStarvedSamples: evidence.micStarvedSamples,
      });
      if (audibility) dependencies.effects.reportAudibility(audibility, nowMs);
      const levelChanged = dependencies.level.observeFrame({
        micLive: dependencies.effects.micPlayable(nowMs),
        frameSamples: frame.byteLength / 2,
        heavyLimitedSamples: evidence.heavyLimitedSamples,
      }, () => ({ songPlaying: dependencies.effects.roomSongPlaying(nowMs), micGainDb: dependencies.mix.micGainDb }));
      if (levelChanged) dependencies.effects.reportLevel('window');
    });
    dependencies.effects.reportTimelineFolds();
  }

  function start() {
    if (timer !== null) return;
    // Construction is inert. The caller chooses the original startup point.
    // A retired callback cannot drain a stopped or subsequently restarted pump.
    const handle = scheduler.setInterval(() => {
      if (timer === handle) tick();
    }, 5);
    timer = handle;
  }

  function stop() {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    scheduler.clearInterval(handle);
  }

  return { ingest, deliver, tick, start, stop };
}
