import type { AudioSession } from './audio-session.js';
import type { BackingRuntime } from './backing-runtime.js';
import type { CalibrationSession } from './calibration-session.js';
import type { AppliedMicOwnerTransition } from './mic-owner-transition-application.js';
import type { MicOwnerTransitionEffects } from './mic-owner-transition.js';
import type { MicTransportGraceRuntime } from './mic-transport-grace-runtime.js';
import type { MicResult } from './participant-session.js';
import type { TakeController } from './take-controller.js';
import { createRelayPublisherActivationCoordinator } from './relay-publisher-activation-coordinator.js';
import { createRelayMicReleaseCoordinator } from './relay-mic-release-coordinator.js';
import { createRelayMicDisconnectCoordinator } from './relay-mic-disconnect-coordinator.js';
import { createRelayMicCaptureRestartCoordinator } from './relay-mic-capture-restart-coordinator.js';

type ParticipantSocket = { participantId?: string };
type ActivationOptions<TSocket> = Parameters<
  typeof createRelayPublisherActivationCoordinator<TSocket, MicOwnerTransitionEffects>
>[0];

export type RelayMicOwnershipHooks = {
  afterQualityEvent?: () => void;
  beforeTimingInvalidation?: () => void;
  invalidateTiming?: (reason: string) => void;
  prepareSongHandoff?: (participantId: string) => void;
};

export type RelayMicLifecycleDependencies<TSocket extends ParticipantSocket> = {
  readonly clock: Readonly<{ now(): number }>;
  readonly participants: Readonly<{
    micOwnerId: string | null;
    releaseMic(ownerId: string, cause: 'transport-expired'): Pick<MicResult, 'ok' | 'effects'>;
  }>;
  readonly mic: Readonly<{
    publisher: TSocket | null;
    mediaOwnerId: string | null;
    audioTransport: unknown | null;
    mediaTicket: unknown | null;
    isPublisher(socket: TSocket): boolean;
    controlConnected(): boolean;
    directMediaConnected(): boolean;
    streaming(nowMs: number): boolean;
    bindPublisher: ActivationOptions<TSocket>['bindPublisher'];
    detachPublisher(socket: TSocket): void;
    clearMediaAuthority(nowMs: number): void;
    directMediaOffer(): unknown;
  }>;
  readonly mix: Readonly<Pick<AudioSession, 'active' | 'setMicExpected' | 'retireMicCapture'>>;
  readonly grace: Readonly<Pick<MicTransportGraceRuntime, 'pending' | 'schedule'>> & Readonly<{ cancel(): void }>;
  readonly backing: Readonly<Pick<BackingRuntime<unknown>, 'connected' | 'armed'>>;
  readonly calibration: Readonly<Pick<CalibrationSession, 'collecting' | 'fail'>>;
  readonly take: Readonly<{
    noteQualityEvent(event: Parameters<TakeController['noteQualityEvent']>[0]): void;
  }>;
  readonly queries: Readonly<{
    participantPayload(participantId: string): Readonly<{ nickname: string }> | null;
  }>;
  readonly commands: Readonly<{
    applyOwnershipEffects(effects: MicOwnerTransitionEffects, nowMs?: number,
      hooks?: RelayMicOwnershipHooks): AppliedMicOwnerTransition;
    invalidateTiming(reason: string): void;
    clearRobotContentTransition(): void;
    refreshLiveMicNetworkCompensation(): void;
    cancelActiveContentValidation(): boolean;
    stopLiveSource(): void;
    beginPreparedSongHandoff(participantId: string): void;
    abandonProbeRun(): void;
    clearContentValidationBaseline(): void;
    syncAppliedCalibration(): void;
  }>;
  readonly effects: Readonly<{
    resetMicAudibility(): void;
    resetMicLevel(): void;
    retirePublisher(socket: TSocket, payload: {
      type: 'mic-revoked' | 'publisher-superseded'; message: string;
    }): void;
    sendRegistered: ActivationOptions<TSocket>['sendRegistered'];
    sendInitialState(socket: TSocket): void;
    sendReleased(socket: TSocket): void;
    reportStatus(): void;
    reportSessionStatus(): void;
    reportTimingStatus(): void;
    reportSourceStatus(): void;
  }>;
};

/** Application sequencing only. Lease, capture, timers, timing and Take remain canonical owners. */
export function createRelayMicLifecycle<TSocket extends ParticipantSocket>(
  dependencies: RelayMicLifecycleDependencies<TSocket>,
) {
  const participants = dependencies.participants;
  const micRuntime = dependencies.mic;
  const session = dependencies.mix;
  const micTransportGrace = dependencies.grace;
  const backingRuntime = dependencies.backing;
  const calibration = dependencies.calibration;
  const takeController = dependencies.take;
  const performance = dependencies.clock;
  const commands = dependencies.commands;
  const effects = dependencies.effects;
  const captureRestart = createRelayMicCaptureRestartLifecycle(dependencies);

  function clearMicMediaAuthority() {
    micRuntime.clearMediaAuthority(performance.now());
    session.setMicExpected(false);
    effects.resetMicAudibility();
    effects.resetMicLevel();
  }

  function expireMicTransportGrace(expectedOwnerId: string) {
    if (participants.micOwnerId !== expectedOwnerId) return;
    if (
      micRuntime.controlConnected()
      && micRuntime.publisher?.participantId === expectedOwnerId
    ) return;

    const directMediaStillFlowing = micRuntime.mediaOwnerId === expectedOwnerId
      && micRuntime.directMediaConnected()
      && micRuntime.streaming(performance.now());
    if (directMediaStillFlowing) {
      micTransportGrace.schedule(expectedOwnerId);
      return;
    }

    const released = participants.releaseMic(expectedOwnerId, 'transport-expired');
    if (!released.ok) return;
    clearMicMediaAuthority();
    commands.applyOwnershipEffects(released.effects);
    effects.reportSessionStatus();
  }

  function retirePublisherTransport(
    previous: TSocket | null,
    type: 'mic-revoked' | 'publisher-superseded',
    message: string,
  ) {
    if (!previous) return false;
    effects.retirePublisher(previous, { type, message });
    return true;
  }

  function revokePublisherTransport(message: string) {
    const previous = micRuntime.publisher;
    const hadMedia = Boolean(previous || micRuntime.audioTransport || micRuntime.mediaTicket);
    if (previous) micRuntime.detachPublisher(previous);
    clearMicMediaAuthority();
    if (previous) retirePublisherTransport(previous, 'mic-revoked', message);
    effects.reportStatus();
    return hadMedia;
  }

  function restartLiveSourceAfterMicReconnect() {
    if (!session.active || !backingRuntime.connected()) return;
    commands.refreshLiveMicNetworkCompensation();
    if (calibration.collecting) {
      calibration.fail('Microphone reconnected during calibration. Start calibration again.');
    }
    if (commands.cancelActiveContentValidation()) effects.reportTimingStatus();
    effects.reportSourceStatus();
  }

  function maybeStopLiveSourceWhenUnarmed() {
    if (!session.active) return;
    const micArmed = micRuntime.controlConnected()
      || micRuntime.directMediaConnected()
      || micTransportGrace.pending;
    const backingArmed = backingRuntime.armed();
    if (!micArmed && !backingArmed) commands.stopLiveSource();
  }

  const publisherActivationCoordinator = createRelayPublisherActivationCoordinator<TSocket, MicOwnerTransitionEffects>({
    now: () => performance.now(),
    participantId: (socket) => socket.participantId ?? null,
    applyOwnershipEffects: (current, hooks) => {
      commands.applyOwnershipEffects(current, performance.now(), {
        invalidateTiming: hooks.invalidateTiming,
        prepareSongHandoff: hooks.prepareSongHandoff,
      });
    },
    bindPublisher: (registration) => micRuntime.bindPublisher(registration),
    retireReplacedCapture: () => {
      commands.clearRobotContentTransition();
      session.retireMicCapture();
      takeController.noteQualityEvent('mic-capture-restarted');
    },
    retirePrevious: (previousPublisher, nextPublisher, sameParticipantReplacement) => {
      const newOwnerName = nextPublisher.participantId
        ? dependencies.queries.participantPayload(nextPublisher.participantId)?.nickname ?? 'Another participant'
        : 'Another microphone';
      retirePublisherTransport(
        previousPublisher,
        sameParticipantReplacement ? 'publisher-superseded' : 'mic-revoked',
        sameParticipantReplacement
          ? 'A newer microphone capture from this participant became active.'
          : `${newOwnerName} took over the microphone.`,
      );
    },
    cancelTransportGrace: () => micTransportGrace.cancel(),
    setMicExpected: () => session.setMicExpected(true),
    sessionActive: () => session.active,
    noteTransportConnected: () => takeController.noteQualityEvent('mic-transport-connected'),
    invalidateTiming: (reason) => commands.invalidateTiming(reason),
    restartLiveSource: () => restartLiveSourceAfterMicReconnect(),
    directMediaOffer: () => micRuntime.directMediaOffer(),
    sendRegistered: (socket, result) => effects.sendRegistered(socket, result),
    sendInitialState: (socket) => effects.sendInitialState(socket),
    broadcastStatus: () => effects.reportStatus(),
    broadcastSessionStatus: () => effects.reportSessionStatus(),
    beginPreparedSongHandoff: (participantId) => commands.beginPreparedSongHandoff(participantId),
  });

  const micReleaseCoordinator = createRelayMicReleaseCoordinator<TSocket, MicOwnerTransitionEffects>({
    publisherParticipantId: () => micRuntime.publisher?.participantId ?? null,
    mediaOwnerId: () => micRuntime.mediaOwnerId,
    revokePublisherTransport: (message) => revokePublisherTransport(message),
    clearMediaAuthority: () => clearMicMediaAuthority(),
    cancelTransportGrace: () => micTransportGrace.cancel(),
    applyOwnershipEffects: (current, hooks) => {
      commands.applyOwnershipEffects(current, performance.now(), {
        afterQualityEvent: hooks.afterQualityEvent,
        beforeTimingInvalidation: hooks.beforeTimingInvalidation,
      });
    },
    broadcastSessionStatus: () => effects.reportSessionStatus(),
    sendReleased: (socket) => effects.sendReleased(socket),
  });

  const micDisconnectCoordinator = createRelayMicDisconnectCoordinator<TSocket>({
    isPublisher: (socket) => micRuntime.isPublisher(socket),
    noteDisconnected: () => takeController.noteQualityEvent('mic-transport-disconnected'),
    reconnectingOwnerId: (socket) => socket.participantId
      && participants.micOwnerId === socket.participantId
      ? socket.participantId
      : null,
    detachPublisher: (socket) => micRuntime.detachPublisher(socket),
    clearMediaAuthority: () => clearMicMediaAuthority(),
    preserveMediaForReconnect: (ownerId) => {
      const directMediaStillLive = micRuntime.directMediaConnected();
      session.setMicExpected(directMediaStillLive);
      micTransportGrace.schedule(ownerId);
    },
    maybeStopLiveSourceWhenUnarmed: () => maybeStopLiveSourceWhenUnarmed(),
    failCalibrationIfCollecting: () => {
      if (calibration.collecting) {
        calibration.fail('Microphone disconnected during calibration.');
      }
    },
    cancelContentValidationAndReport: () => {
      if (commands.cancelActiveContentValidation()) effects.reportTimingStatus();
    },
    reportStatus: () => effects.reportStatus(),
  });

  return {
    restartCapture: captureRestart.restartCapture,
    activate: publisherActivationCoordinator.activate,
    release: micReleaseCoordinator.release,
    disconnect: micDisconnectCoordinator.handle,
    expire: expireMicTransportGrace,
    clearMediaAuthority: clearMicMediaAuthority,
  } as const;
}

export type RelayMicCaptureRestartLifecycleDependencies = {
  readonly take: Readonly<{
    noteQualityEvent(event: Parameters<TakeController['noteQualityEvent']>[0]): void;
  }>;
  readonly calibration: Readonly<Pick<CalibrationSession, 'fail'>>;
  readonly commands: Readonly<{
    abandonProbeRun(): void;
    clearContentValidationBaseline(): void;
    syncAppliedCalibration(): void;
  }>;
  readonly effects: Readonly<{
    reportTimingStatus(): void;
    reportSourceStatus(): void;
  }>;
};

/** Restart effect binding only; capture detection and collecting sampling stay in the pump. */
export function createRelayMicCaptureRestartLifecycle(
  dependencies: RelayMicCaptureRestartLifecycleDependencies,
) {
  const coordinator = createRelayMicCaptureRestartCoordinator({
    noteQualityEvent: (event) => dependencies.take.noteQualityEvent(event),
    abandonProbeRun: () => dependencies.commands.abandonProbeRun(),
    clearContentValidation: () => dependencies.commands.clearContentValidationBaseline(),
    failCalibration: (message) => dependencies.calibration.fail(message),
    syncAppliedCalibration: () => { dependencies.commands.syncAppliedCalibration(); },
    reportTimingStatus: () => dependencies.effects.reportTimingStatus(),
    reportSourceStatus: () => dependencies.effects.reportSourceStatus(),
  });
  return { restartCapture: coordinator.restart } as const;
}
